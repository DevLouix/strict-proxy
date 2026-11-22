/**
 * Disputes (chargebacks): what is being disputed and the evidence packet.
 *
 * A dispute already revokes access when it opens, so unless evidence is filed
 * before the provider's deadline the money is simply lost. That workflow existed
 * only as routes, which left an operator curling their own API to save a charge.
 * This is the screen that closes the loop.
 *
 * Nothing is cached: every list and detail is read from the provider through the
 * controller, because the provider's dispute record is what decides the outcome.
 */
import { h, mount, money, date, badge, toast } from './dom.js';

const STATUSES = [
  ['', 'All statuses'],
  ['open', 'Open'],
  ['under_review', 'Under review'],
  ['won', 'Won'],
  ['lost', 'Lost'],
  ['resolved', 'Resolved'],
];

/** Statuses where the chargeback is still undecided and evidence still matters. */
const OPEN_STATUSES = new Set(['open', 'under_review']);

/** The dispute's own fields, without the evidence history. */
function factsTable(d) {
  const resolution = d.resolution
    ? `${d.resolution}${d.resolved_at ? ` · ${date(d.resolved_at)}` : ''}`
    : d.resolved_at
      ? date(d.resolved_at)
      : '—';

  const facts = [
    ['Dispute', d.id],
    ['Charge', d.transaction_id ?? '—'],
    ['Provider', d.provider ?? '—'],
    ['Type', d.dispute_type ?? '—'],
    ['Amount', d.amount != null ? money(d.amount, d.currency) : '—'],
    ['Opened', date(d.created_at)],
    ['Reason', d.reason ?? '—'],
    ['Evidence filed', d.evidence_submitted_at ? date(d.evidence_submitted_at) : 'not yet'],
    ['Resolution', resolution],
  ];

  return h('div', { class: 'table-wrap' },
    h('table', { class: 'facts-table' },
      h('tbody', {}, ...facts.map(([label, value]) => h('tr', {},
        h('th', { class: 'small muted' }, label),
        h('td', { class: 'small' }, value),
      ))),
    ),
  );
}

/** One evidence submission, with the manual "filed with the provider" control. */
function submissionRow(api, disputeId, submission, onFiled) {
  const mark = h('button', { class: 'btn sm' }, 'Mark filed');
  mark.addEventListener('click', async () => {
    mark.disabled = true;
    mark.textContent = 'Marking…';
    try {
      await api.post(
        `/api/v1/admin/disputes/${encodeURIComponent(disputeId)}/evidence/${encodeURIComponent(submission.id)}/submitted`,
        {},
      );
      toast('Marked as filed with the provider');
      await onFiled();
    } catch (err) {
      toast(err.message || 'Could not mark the packet as filed', 'err');
      mark.disabled = false;
      mark.textContent = 'Mark filed';
    }
  });

  const fileUrls = submission.file_urls ?? [];

  return h('tr', {},
    h('td', { class: 'small' }, submission.submitted_by ?? '—'),
    h('td', {}, badge(submission.submission_status ?? 'pending')),
    h('td', { class: 'small muted' }, submission.provider_status ?? '—'),
    h('td', { class: 'small' }, date(submission.created_at)),
    h('td', { class: 'small' },
      h('div', {}, submission.narrative ?? ''),
      fileUrls.length
        ? h('div', { class: 'stack', style: 'margin-top:4px' },
            ...fileUrls.map((url) => h('a', { href: url, target: '_blank', rel: 'noreferrer' }, url)),
          )
        : null,
    ),
    h('td', { class: 'actions' },
      submission.submission_status === 'pending'
        ? mark
        : h('span', { class: 'muted small' }, '—'),
    ),
  );
}

/** The narrative + supporting-file form used to answer an open dispute. */
function evidenceForm(api, disputeId, onFiled) {
  const narrative = h('textarea', {
    rows: '4',
    placeholder: 'What was delivered, when, and how the provider can verify it (at least 20 characters).',
  });
  const files = h('textarea', {
    rows: '2',
    placeholder: 'Supporting file URLs, one per line (optional).',
  });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'File evidence');

  return h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      const text = narrative.value.trim();
      // The controller enforces the same minimum; checking here avoids a round
      // trip that would only come back as a validation error.
      if (text.length < 20) {
        toast('The narrative must be at least 20 characters', 'err');
        return;
      }
      const fileUrls = files.value.split('\n').map((line) => line.trim()).filter(Boolean);
      submit.disabled = true;
      submit.textContent = 'Filing…';
      try {
        await api.post(`/api/v1/admin/disputes/${encodeURIComponent(disputeId)}/evidence`, {
          narrative: text,
          ...(fileUrls.length ? { file_urls: fileUrls } : {}),
        });
        toast('Evidence filed');
        await onFiled();
      } catch (err) {
        toast(err.message || 'Could not file evidence', 'err');
        submit.disabled = false;
        submit.textContent = 'File evidence';
      }
    },
  },
    h('h4', {}, 'File an evidence packet'),
    h('label', { class: 'field' }, h('span', {}, 'Narrative'), narrative),
    h('label', { class: 'field' }, h('span', {}, 'Supporting files'), files),
    h('p', { class: 'muted small' },
      'Filing records the packet with the provider. Some providers still have no evidence API, so mark the packet as filed once it has been submitted in their dashboard.'),
    h('div', { class: 'actions' }, submit),
  );
}

/** Opens the detail dialog for one dispute and loads its evidence history. */
async function openDisputeDialog(api, summary, onChanged) {
  const body = h('div', { class: 'dlg-body' });
  const dlg = h('dialog', { class: 'wide' },
    h('div', { class: 'dlg-head' }, h('h3', {}, `Dispute ${summary.id}`)),
    body,
    h('div', { class: 'dlg-foot' },
      h('button', { class: 'btn', onClick: () => dlg.close() }, 'Close'),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove(), { once: true });
  dlg.showModal();

  let detail = summary;
  let submissions = [];

  async function refresh() {
    const [detailRes, evidenceRes] = await Promise.all([
      api.get(`/api/v1/admin/disputes/${encodeURIComponent(summary.id)}`),
      api.get(`/api/v1/admin/disputes/${encodeURIComponent(summary.id)}/evidence`).catch(() => ({ submissions: [] })),
    ]);
    detail = detailRes.dispute ?? summary;
    submissions = evidenceRes.submissions ?? [];
    draw();
  }

  /** Reloads the dialog and the list behind it after anything is filed. */
  async function filed() {
    await refresh();
    if (onChanged) await onChanged();
  }

  function draw() {
    const undecided = OPEN_STATUSES.has(detail.status);
    mount(body,
      h('div', { class: 'row' },
        badge(detail.status ?? 'unknown'),
        undecided
          ? h('span', { class: 'small muted' }, 'Access was revoked when this dispute opened; winning restores it.')
          : null,
      ),
      factsTable(detail),
      h('h4', {}, 'Evidence submissions'),
      submissions.length === 0
        ? h('div', { class: 'empty' }, 'No evidence has been filed for this dispute.')
        : h('div', { class: 'table-wrap' },
            h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'By'),
                h('th', {}, 'State'),
                h('th', {}, 'Provider state'),
                h('th', {}, 'Created'),
                h('th', {}, 'Narrative'),
                h('th', { class: 'right' }, ''),
              )),
              h('tbody', {}, ...submissions.map((s) =>
                submissionRow(api, summary.id, s, filed))),
            ),
          ),
      undecided || submissions.length === 0
        ? evidenceForm(api, summary.id, filed)
        : h('p', { class: 'muted small' }, 'This dispute is closed; no further evidence is needed.'),
    );
  }

  try {
    await refresh();
  } catch (err) {
    mount(body, h('div', { class: 'empty' }, err.message || 'Could not load this dispute.'));
  }
}

export async function disputesView(api) {
  const host = h('div', {});
  let status = '';
  let rows = [];
  let hasMore = false;
  let unavailable = null;

  async function load() {
    try {
      const suffix = status ? `?status=${encodeURIComponent(status)}` : '';
      const data = await api.get(`/api/v1/admin/disputes${suffix}`);
      rows = data.disputes ?? [];
      hasMore = Boolean(data.hasMore);
      unavailable = null;
    } catch (err) {
      // An unconfigured gateway is a deployment state, not a broken screen:
      // say so on the page instead of blanking the tab behind a toast.
      if (err.code === 'BILLING_NOT_CONFIGURED') {
        rows = [];
        hasMore = false;
        unavailable = err.message;
      } else {
        throw err;
      }
    }
    draw();
  }

  function draw() {
    const openRows = rows.filter((d) => OPEN_STATUSES.has(d.status));
    const atStake = openRows.reduce((total, d) => total + (Number(d.amount) || 0), 0);
    const currency = openRows[0]?.currency ?? rows[0]?.currency ?? 'USD';

    const select = h('select', {
      onChange: (e) => {
        status = e.target.value;
        load();
      },
    }, ...STATUSES.map(([value, label]) => h('option', { value, selected: status === value }, label)));

    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Disputes'),
          h('p', {}, 'Chargebacks raised against settled payments, and the evidence that answers them.'),
        ),
        h('div', { class: 'row' },
          select,
          h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
        ),
      ),
      unavailable
        ? h('div', { class: 'panel' },
            h('div', { class: 'empty' },
              `Disputes are read from the payment gateway, which is not configured: ${unavailable}`),
          )
        : null,
      h('div', { class: 'stats' },
        h('div', { class: 'stat' },
          h('div', { class: 'label' }, 'In view'),
          h('div', { class: 'value' }, String(rows.length)),
        ),
        h('div', { class: 'stat' },
          h('div', { class: 'label' }, 'Open amount'),
          h('div', { class: 'value' }, money(atStake, currency)),
          h('div', { class: 'hint' }, 'open and under review, in this view'),
        ),
      ),
      h('div', { class: 'panel' },
        h('header', {},
          h('h3', {}, 'Chargebacks'),
          hasMore
            ? h('span', { class: 'muted small' }, 'The provider holds more than are shown here; filter by status.')
            : null,
        ),
        h('div', { class: 'table-wrap' },
          unavailable
            ? h('div', { class: 'empty' }, 'Nothing to show without the payment gateway.')
            : rows.length === 0
              ? h('div', { class: 'empty' }, 'No disputes match this filter.')
              : h('table', {},
                  h('thead', {}, h('tr', {},
                    h('th', {}, 'Dispute'),
                    h('th', {}, 'Charge'),
                    h('th', {}, 'Type'),
                    h('th', {}, 'Amount'),
                    h('th', {}, 'Status'),
                    h('th', {}, 'Opened'),
                    h('th', {}, 'Evidence'),
                    h('th', { class: 'right' }, 'Actions'),
                  )),
                  h('tbody', {}, ...rows.map((d) => h('tr', {},
                    h('td', {},
                      h('div', { class: 'mono' }, d.id),
                      d.reason ? h('span', { class: 'muted small' }, String(d.reason).slice(0, 80)) : null,
                    ),
                    h('td', { class: 'small mono' }, d.transaction_id ?? '—'),
                    h('td', { class: 'small' }, d.dispute_type ?? '—'),
                    h('td', { class: 'small' }, money(d.amount, d.currency)),
                    h('td', {}, badge(d.status ?? 'unknown')),
                    h('td', { class: 'small muted' }, date(d.created_at)),
                    h('td', {},
                      d.evidence_submitted_at
                        ? h('span', { class: 'badge active' }, 'filed')
                        : h('span', { class: 'badge pending' }, 'not filed'),
                    ),
                    h('td', { class: 'actions' },
                      h('button', {
                        class: 'btn sm',
                        onClick: () => openDisputeDialog(api, d, load),
                      }, 'Open'),
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

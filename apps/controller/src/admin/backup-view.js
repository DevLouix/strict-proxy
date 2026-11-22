/**
 * Operator backup: download a portable snapshot, or restore one.
 *
 * The snapshot contains credentials (password hashes, node HMAC secrets and
 * REALITY private keys), so this screen describes it as sensitive rather than
 * presenting it as a routine export. Restore replaces every user and signs the
 * current session out, so it is a two-step action: pick the file, then confirm.
 *
 * APK binaries are not part of the JSON. The release metadata is restored, but
 * the files under CLIENT_ANDROID_STORAGE_DIR must be copied separately.
 */
import { h, mount, toast } from './dom.js';
import { clearSession } from './api.js';

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

function filenameFor(snapshot) {
  const generated = typeof snapshot?.generatedAt === 'string' ? snapshot.generatedAt : '';
  const date = /^\d{4}-\d{2}-\d{2}/.test(generated) ? generated.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return `strict-proxy-backup-${date}.json`;
}

/** Saves the already-parsed snapshot as a downloaded JSON file. */
function saveSnapshot(snapshot) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filenameFor(snapshot) });
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function countsTable(counts) {
  const rows = Object.entries(counts ?? {}).map(([table, count]) =>
    h('tr', {}, h('td', {}, table), h('td', { class: 'mono' }, String(count))),
  );
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Table'), h('th', {}, 'Rows'))),
      h('tbody', {}, ...rows),
    ),
  );
}

export async function backupView(api) {
  const host = h('div', {});
  let result = null;

  function render() {
    const exportBtn = h('button', { class: 'btn primary', type: 'button' }, 'Download backup');
    const exportError = h('p', { class: 'muted small', style: 'min-height:18px' });

    const fileInput = h('input', {
      type: 'file',
      accept: 'application/json,.json',
      'aria-label': 'Backup file',
    });
    const importBtn = h('button', { class: 'btn danger', type: 'button' }, 'Restore this backup');
    const importError = h('p', { class: 'muted small', style: 'min-height:18px' });

    exportBtn.addEventListener('click', async () => {
      exportError.textContent = '';
      exportBtn.disabled = true;
      exportBtn.textContent = 'Preparing…';
      try {
        const snapshot = await api.get('/api/v1/admin/backup/export');
        saveSnapshot(snapshot);
        toast('Backup downloaded');
      } catch (err) {
        exportError.textContent = err.message || 'Could not export the platform';
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = 'Download backup';
      }
    });

    importBtn.addEventListener('click', async () => {
      importError.textContent = '';
      const file = fileInput.files?.[0];
      if (!file) {
        importError.textContent = 'Choose a backup file first.';
        return;
      }
      if (file.size > MAX_IMPORT_BYTES) {
        importError.textContent = 'That file is larger than the 64 MB import limit.';
        return;
      }

      const confirmed = confirm(
        `Replace every user, node, subscription, payment and setting with the contents of ${file.name}?\n\n` +
        'The current session will be signed out and the platform will be unusable until you sign in with an account from the backup.',
      );
      if (!confirmed) return;

      importBtn.disabled = true;
      importBtn.textContent = 'Restoring…';
      try {
        const raw = await file.text();
        let snapshot;
        try {
          snapshot = JSON.parse(raw);
        } catch {
          throw new Error('That file is not valid JSON.');
        }
        if (snapshot?.format !== 'strict-proxy-backup') {
          throw new Error('That is not a StrictProxy backup file.');
        }

        result = await api.post('/api/v1/admin/backup/import', { ...snapshot, confirm: 'replace' });
        clearSession();
        render();
        toast('Backup restored. Sign in again with an account from the backup.');
      } catch (err) {
        importError.textContent = err.message || 'The backup could not be restored';
        importBtn.disabled = false;
        importBtn.textContent = 'Restore this backup';
      }
    });

    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Backup'),
          h('p', {}, 'Move the platform to a fresh server, or recover without the database volume.'),
        ),
      ),
      result
        ? h('div', { class: 'panel' },
            h('header', {}, h('h3', {}, 'Restore complete')),
            h('div', { class: 'notice' },
              'The backup was applied. Your previous session was revoked by the restore; sign in with an account that was in the backup.',
            ),
            countsTable(result.restored),
            h('div', { class: 'actions' },
              h('button', { class: 'btn primary', type: 'button', onClick: () => location.reload() }, 'Sign in again'),
            ),
          )
        : null,
      h('div', { class: 'panel' },
        h('header', {}, h('h3', {}, 'Download'), h('span', { class: 'muted small' }, 'Authenticated, never cached')),
        h('p', { class: 'muted' },
          'Exports users, subscriptions, nodes, node credentials, payments, usage, settings, client-release metadata and crash reports. ',
          'The file contains password hashes and node private keys: store it like the database itself.',
        ),
        h('div', { class: 'notice' },
          'Not included: live sessions, password-reset links, environment values and APK files. ',
          'Keep the original ', h('code', {}, 'SIGNING_PRIVATE_KEY_PEM'), ', ',
          h('code', {}, 'SIGNING_KEY_ID'), ' and ', h('code', {}, 'SETTINGS_ENCRYPTION_KEY'),
          ' with the backup, and copy ', h('code', {}, 'CLIENT_ANDROID_STORAGE_DIR'),
          ' if you publish Android builds.',
        ),
        h('div', { class: 'actions' }, exportBtn, exportError),
      ),
      h('div', { class: 'panel' },
        h('header', {}, h('h3', {}, 'Restore'), h('span', { class: 'badge offline' }, 'Replaces state')),
        h('p', { class: 'muted' },
          'Restoring replaces every user, node, subscription, payment and setting in this deployment. ',
          'It runs in one transaction: a rejected file leaves the running platform unchanged.',
        ),
        h('div', { class: 'form-grid' },
          h('label', { class: 'field' },
            h('span', { class: 'field-label' }, 'Backup file'),
            fileInput,
            h('span', { class: 'muted small' }, 'A .json file exported by StrictProxy (maximum 64 MB)'),
          ),
        ),
        h('div', { class: 'actions' }, importBtn, importError),
      ),
    );
  }

  render();
  return host;
}

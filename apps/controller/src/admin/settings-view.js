/**
 * Operator settings: SMTP credentials for the deployment's mail server.
 *
 * The password field is write-only, and the form says so. An operator needs to
 * know *whether* a password is stored — leaving it blank keeps the current one,
 * which is not the same as clearing it — but must never be able to read it back
 * out of the dashboard. Clearing is an explicit action.
 */
import { h, mount, toast, emailInput } from './dom.js';
import { passwordField } from './password-toggle.js';

export async function settingsView(api) {
  const host = h('div', {});
  let state = null;

  async function load() {
    state = await api.get('/api/v1/admin/settings/email');
    render();
  }

  function field(label, input, hint) {
    return h('label', { class: 'field' },
      h('span', { class: 'field-label' }, label),
      input,
      hint ? h('span', { class: 'muted small' }, hint) : null,
    );
  }

  function render() {
    const summary = state?.summary ?? null;
    const configured = Boolean(state?.configured);

    const host0 = h('input', { type: 'text', value: summary?.host ?? '', placeholder: 'smtp.example.com', spellcheck: 'false' });
    const port0 = h('input', { type: 'number', value: String(summary?.port ?? 587), min: '1', max: '65535' });
    const secure0 = h('input', { type: 'checkbox', checked: Boolean(summary?.secure) });
    const user0 = h('input', { type: 'text', value: summary?.username ?? '', placeholder: 'postmaster@example.com', spellcheck: 'false', autocomplete: 'off' });
    // passwordField returns a wrapper, not the input; reading `.value` from the
    // wrapper silently sent no password at all, so SMTP authenticated with an
    // empty credential ("Missing credentials for PLAIN").
    const passInput = h('input', { type: 'password', placeholder: summary?.passwordSet ? '•••••••• (unchanged)' : 'not set', autocomplete: 'new-password' });
    const pass0 = passwordField(passInput);
    const from0 = emailInput({ value: summary?.fromAddress ?? '', placeholder: 'no-reply@example.com' });
    const name0 = h('input', { type: 'text', value: summary?.fromName ?? '', placeholder: 'StrictProxy' });
    const testTo0 = emailInput({ placeholder: 'you@example.com' });

    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save settings');
    const testBtn = h('button', { class: 'btn', type: 'button' }, 'Send test message');
    const clearBtn = h('button', { class: 'btn danger', type: 'button' }, 'Disable mail');

    const formError = h('p', { class: 'muted small', style: 'min-height:18px' });
    const testError = h('p', { class: 'muted small', style: 'min-height:18px' });

    // 465 is implicit TLS; 587 and 25 negotiate STARTTLS. A mismatch here is
    // indistinguishable from a bad password in the server's reply, so keep the
    // checkbox honest when the operator picks one of those ports.
    port0.addEventListener('input', () => {
      const port = Number.parseInt(port0.value, 10);
      if (port === 465) secure0.checked = true;
      else if (port === 587 || port === 25) secure0.checked = false;
    });

    /** Saves the form. Returns false and reports the reason on failure. */
    async function saveSettings({ refresh = true } = {}) {
      formError.textContent = '';
      save.disabled = true;
      try {
        // The password is only sent when typed, so a blank field leaves the
        // stored one alone instead of clearing it by accident.
        const body = {
          host: host0.value.trim(),
          port: Number.parseInt(port0.value, 10),
          secure: secure0.checked,
          fromAddress: from0.value.trim(),
        };
        if (user0.value.trim()) body.username = user0.value.trim();
        if (name0.value.trim()) body.fromName = name0.value.trim();
        if (passInput.value) body.password = passInput.value;
        await api.put('/api/v1/admin/settings/email', body);
        passInput.value = '';
        toast('Mail settings saved');
        if (refresh) await load();
        return true;
      } catch (err) {
        formError.textContent = err.detail ? `${err.message}: ${err.detail}` : (err.message || 'Save failed');
        save.disabled = false;
        return false;
      }
    }

    const form = h('form', {
      onSubmit: async (e) => {
        e.preventDefault();
        await saveSettings();
      },
    },
      field('SMTP host', host0),
      field('Port', port0, '587 is STARTTLS; 465 is implicit TLS'),
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, 'Implicit TLS'),
        h('div', { class: 'inline' },
          secure0,
          h('span', { class: 'muted small' }, 'On for port 465; leave off to use STARTTLS'),
        ),
      ),
      field('Username', user0, 'Leave empty for an unauthenticated relay'),
      field('Password', pass0, summary?.passwordSet
        ? 'A password is stored. Leave blank to keep it; it cannot be read back.'
        : 'No password stored.'),
      field('From address', from0, 'Must be a domain your mail server is allowed to send from'),
      field('From name', name0),
      h('div', { class: 'actions' }, save, formError),
    );

    testBtn.addEventListener('click', async () => {
      const to = testTo0.value.trim();
      if (!to) {
        toast('Enter an address to send the test to', 'error');
        return;
      }
      testError.textContent = '';
      testBtn.disabled = true;
      try {
        // The endpoint tests what is stored, not what is typed. Saving first is
        // what an operator means by "send a test" after filling the form; skip
        // the reload so the error below stays inside the Test panel.
        if (!(await saveSettings({ refresh: false }))) {
          testError.textContent = 'Fix the settings above before sending a test.';
          return;
        }
        await api.post('/api/v1/admin/settings/email/test', { to });
        toast(`Test message sent to ${to}`);
        await load();
      } catch (err) {
        // Nodemailer's reply names the actual failure (535 auth, TLS, DNS).
        const detail = err.detail ? `${err.message}: ${err.detail}` : (err.message || 'Test message failed');
        testError.textContent = detail;
        toast(detail, 'error');
      } finally {
        testBtn.disabled = false;
      }
    });

    clearBtn.addEventListener('click', async () => {
      if (!confirm('Remove all mail settings? Password reset emails and lapse notices will stop being sent.')) return;
      try {
        await api.del('/api/v1/admin/settings/email');
        toast('Mail settings removed');
        await load();
      } catch (err) {
        toast(err.message || 'Could not remove mail settings', 'error');
      }
    });

    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Settings'),
          h('p', {}, 'Outbound mail for password resets and subscription notices.'),
        ),
        h('span', { class: configured ? 'badge active' : 'badge offline' }, configured ? 'Mail configured' : 'Mail not configured'),
      ),
      !configured
        ? h('div', { class: 'panel' },
            h('div', { class: 'notice' },
              'Without mail, password resets can only be delivered by hand: ',
              h('code', {}, 'POST /api/v1/admin/users/:userId/password-reset'),
              '. Configure a server below to email them automatically.',
            ),
          )
        : null,
      h('div', { class: 'panel' },
        h('header', {}, h('h3', {}, 'SMTP server')),
        h('div', { class: 'form-grid' }, form),
      ),
      h('div', { class: 'panel' },
        h('header', {}, h('h3', {}, 'Test'),
          h('span', { class: 'muted small' }, 'Sends to an address you choose, not to the from address'),
        ),
        h('div', { class: 'form-grid' },
          h('div', { class: 'inline' },
            h('div', { style: 'flex:1' }, testTo0),
            testBtn,
          ),
          testError,
        ),
      ),
      h('div', { class: 'panel' },
        h('header', {}, h('h3', {}, 'Danger zone')),
        h('div', { class: 'inline' },
          clearBtn,
          h('span', { class: 'muted small' }, 'Removes the credentials above. Nothing is sent after this.'),
        ),
      ),
    );
  }

  await load();
  return host;
}

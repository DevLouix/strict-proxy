/**
 * Operator settings: SMTP credentials for the deployment's mail server.
 *
 * The password field is write-only, and the form says so. An operator needs to
 * know *whether* a password is stored — leaving it blank keeps the current one,
 * which is not the same as clearing it — but must never be able to read it back
 * out of the dashboard. Clearing is an explicit action.
 */
import { h, mount, toast } from './dom.js';
import { passwordField } from './password-toggle.js';

export async function settingsView(api) {
  const host = h('div', {});
  let state = null;
  let gate = null;
  let published = null;

  async function load() {
    [state, gate, published] = await Promise.all([
      api.get('/api/v1/admin/settings/email'),
      // Optional panels: a controller that predates them must not blank the
      // whole settings screen.
      api.get('/api/v1/admin/settings/client').catch(() => null),
      api.get('/api/v1/app/android').catch(() => null),
    ]);
    render();
  }

  function field(label, input, hint) {
    return h('label', { class: 'field' },
      h('span', { class: 'field-label' }, label),
      input,
      hint ? h('span', { class: 'muted small' }, hint) : null,
    );
  }

  /**
   * The minimum build that may connect. Shown as a build number because that is
   * what the APK, Android and the in-app updater all compare; the published
   * version name is displayed beside it purely to help an operator pick it.
   */
  function clientVersionPanel() {
    const enabled = Boolean(gate?.enabled);
    const publishedBuild = Number.isSafeInteger(published?.buildNumber) ? published.buildNumber : null;
    const enforce = h('input', {
      type: 'checkbox',
      id: 'client-version-gate',
      checked: enabled,
    });
    const min0 = h('input', {
      type: 'number',
      id: 'client-version-min',
      min: '1',
      step: '1',
      value: gate?.minimumBuild != null ? String(gate.minimumBuild) : '',
      placeholder: publishedBuild ? String(publishedBuild) : 'e.g. 68',
      disabled: !enabled,
    });
    const error = h('p', { class: 'muted small', style: 'min-height:18px' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, enabled ? 'Save minimum' : 'Allow every build');

    /** Keeps the number field and the button honest while the switch moves. */
    function syncSwitch() {
      min0.disabled = !enforce.checked;
      save.textContent = enforce.checked ? 'Save minimum' : 'Allow every build';
      // Turning the gate on with nothing typed would otherwise save an invalid
      // value; the published build is the safe starting point.
      if (enforce.checked && !min0.value.trim() && publishedBuild) min0.value = String(publishedBuild);
    }
    enforce.addEventListener('change', syncSwitch);

    const form = h('form', {
      onSubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        save.disabled = true;
        try {
          const minimumBuild = enforce.checked ? Number(min0.value.trim()) : 0;
          if (enforce.checked && (!min0.value.trim() || !Number.isInteger(minimumBuild) || minimumBuild < 1)) {
            throw new Error('Enter the build number allowed to connect, or switch the gate off.');
          }
          await api.put('/api/v1/admin/settings/client', { minimumBuild });
          toast(minimumBuild > 0
            ? `Builds below ${minimumBuild} can no longer connect`
            : 'Client version gate off — every build may connect');
          await load();
        } catch (err) {
          error.textContent = err.message || 'Save failed';
          save.disabled = false;
        }
      },
    },
      h('label', { class: 'switch', for: 'client-version-gate' },
        enforce,
        h('span', { class: 'switch-track' }, h('span', { class: 'switch-knob' })),
        h('span', { class: 'switch-text' },
          h('strong', {}, 'Gate client versions'),
          h('span', { class: 'muted small' },
            'Off: every build may connect. On: only builds at or above the minimum get tunnel credentials.'),
        ),
      ),
      field('Minimum build that may connect', min0,
        publishedBuild
          ? `Published build: ${publishedBuild}${published.version ? ` (v${published.version})` : ''}. Used only while the switch is on.`
          : 'No build is published yet. Set the minimum to a build users can actually install.'),
      h('div', { class: 'actions' }, save, error),
    );

    return h('div', { class: 'panel' },
      h('header', {},
        h('h3', {}, 'Client version'),
        h('span', { class: enabled ? 'badge active' : 'badge offline' },
          enabled ? `Minimum build ${gate.minimumBuild}` : 'All builds allowed'),
      ),
      h('div', { class: 'form-grid' }, form),
      h('p', { class: 'muted small' },
        'Refused builds cannot fetch tunnel credentials (',
        h('code', {}, '426 CLIENT_UPDATE_REQUIRED'),
        ') and the app offers its in-app update. Builds older than this check send no '
        + 'build number, so enabling the gate blocks them too — set the minimum to the '
        + 'build users can actually install.'),
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
    const from0 = h('input', { type: 'email', value: summary?.fromAddress ?? '', placeholder: 'no-reply@example.com', spellcheck: 'false' });
    const name0 = h('input', { type: 'text', value: summary?.fromName ?? '', placeholder: 'StrictProxy' });
    const testTo0 = h('input', { type: 'email', placeholder: 'you@example.com', spellcheck: 'false' });

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
      clientVersionPanel(),
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

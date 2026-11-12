/**
 * Admin dashboard shell: session bootstrap, navigation, view mounting.
 */
import { ApiClient, getSession, clearSession, setUnauthorizedHandler } from './api.js';
import { h, mount, toast } from './dom.js';
import { passwordField } from './password-toggle.js';
import { overviewView, usersView, nodesView, enrollmentsView, paymentsView, usageView } from './views.js';
import { settingsView } from './settings-view.js';
import { plansView, subscriptionsView } from './billing-ops-view.js';
import { couponsView } from './coupons-view.js';
import { clientAppsView } from './client-apps-view.js';
import { disputesView } from './disputes-view.js';
import { auditView } from './audit-view.js';
import { backupView } from './backup-view.js';

const api = new ApiClient();
const root = document.getElementById('root');

const VIEWS = [
  { id: 'overview', label: 'Overview', render: overviewView },
  { id: 'users', label: 'Users', render: usersView },
  { id: 'nodes', label: 'Nodes', render: nodesView },
  { id: 'enrollments', label: 'Enrollments', render: enrollmentsView },
  { id: 'payments', label: 'Payments', render: paymentsView },
  { id: 'disputes', label: 'Disputes', render: disputesView },
  { id: 'audit', label: 'Audit log', render: auditView },
  { id: 'usage', label: 'Usage', render: usageView },
  { id: 'plans', label: 'Plans', render: plansView },
  { id: 'coupons', label: 'Coupons', render: couponsView },
  { id: 'subscriptions', label: 'Subscriptions', render: subscriptionsView },
  { id: 'client-apps', label: 'Client apps', render: clientAppsView },
  { id: 'backup', label: 'Backup', render: backupView },
  { id: 'settings', label: 'Settings', render: settingsView },
];

function loginScreen() {
  const email = h('input', { type: 'email', placeholder: 'admin@strict.local', autocomplete: 'username' });
  const password = h('input', { type: 'password', placeholder: '••••••••••', autocomplete: 'current-password' });
  const error = h('p', { class: 'muted small', style: 'min-height:18px' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');

  const form = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      try {
        await api.login(email.value.trim(), password.value);
        await boot();
      } catch (err) {
        error.textContent = err.message || 'Sign-in failed';
        submit.disabled = false;
        submit.textContent = 'Sign in';
      }
    },
  },
    h('label', { class: 'field' }, h('span', {}, 'Email'), email),
    h('label', { class: 'field' }, h('span', {}, 'Password'), passwordField(password)),
    error,
    submit,
  );

  mount(root,
    h('div', { class: 'login-wrap' },
      h('div', { class: 'login-card' },
        h('h1', {}, 'StrictProxy Admin'),
        h('p', { class: 'sub' }, 'Sign in with an administrator account.'),
        form,
      ),
    ),
  );
  email.focus();
}

let currentView = 'overview';

async function renderView(viewId) {
  const view = VIEWS.find((v) => v.id === viewId) ?? VIEWS[0];
  currentView = view.id;

  const main = document.getElementById('main');
  if (!main) return;

  // Reflect the active item before awaiting data.
  for (const el of document.querySelectorAll('.nav-item')) {
    el.classList.toggle('active', el.dataset.view === view.id);
  }
  if (location.hash.slice(1) !== view.id) location.hash = view.id;

  mount(main, h('div', { class: 'page-head' }, h('div', { class: 'muted' }, h('span', { class: 'spinner' }), ' Loading…')));

  try {
    const node = await view.render(api, () => renderView(view.id));
    mount(main, node);
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      clearSession();
      await boot();
      return;
    }
    toast(err.message || 'Failed to load view', 'err');
    mount(main,
      h('div', { class: 'page-head' }, h('div', {}, h('h2', {}, 'Something went wrong'))),
      h('div', { class: 'panel' }, h('div', { class: 'empty' }, err.message || 'Failed to load this view.')),
    );
  }
}

function shell(email) {
  const nav = h('nav', {},
    ...VIEWS.map((v) => h('button', {
      class: `nav-item${v.id === currentView ? ' active' : ''}`,
      dataset: { view: v.id },
      onClick: () => renderView(v.id),
    }, v.label)),
  );

  mount(root,
    h('div', { class: 'shell' },
      h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' }, h('span', { class: 'dot' }), 'StrictProxy'),
        nav,
        h('div', { class: 'spacer' }),
        h('div', { class: 'who' },
          h('div', {}, email),
          h('button', {
            class: 'btn sm',
            style: 'margin-top:8px',
            onClick: async () => { await api.logout(); await boot(); },
          }, 'Sign out'),
        ),
      ),
      h('main', { class: 'main', id: 'main' }),
    ),
  );
}

async function boot() {
  const session = getSession();
  if (!session?.accessToken) {
    loginScreen();
    return;
  }

  // Validate the stored token (refreshing if needed) before showing the shell,
  // so a stale session lands on the login screen rather than an error view.
  let profile;
  try {
    profile = await api.me();
  } catch {
    clearSession();
    loginScreen();
    return;
  }

  if (profile?.user?.role !== 'admin') {
    clearSession();
    loginScreen();
    toast('That account is not an administrator.', 'err');
    return;
  }

  const email = profile.user.email;
  shell(email);
  const requested = location.hash.slice(1);
  await renderView(VIEWS.some((v) => v.id === requested) ? requested : 'overview');
}

setUnauthorizedHandler(() => {
  clearSession();
  loginScreen();
});

window.addEventListener('hashchange', () => {
  if (getSession()) renderView(location.hash.slice(1) || 'overview');
});

boot();
/**
 * Admin dashboard shell: session bootstrap, navigation, view mounting.
 */
import { ApiClient, getSession, clearSession, setUnauthorizedHandler } from './api.js';
import { h, mount, toast, emailInput } from './dom.js';
import { createSidebar, navIcon } from './nav.js';
import { passwordField } from './password-toggle.js';
import { overviewView, usersView, nodesView, enrollmentsView, paymentsView, usageView } from './views.js';
import { settingsView } from './settings-view.js';
import { plansView, subscriptionsView } from './billing-ops-view.js';
import { couponsView } from './coupons-view.js';
import { linksView } from './links-view.js';
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
  { id: 'links', label: 'Links', render: linksView },
  { id: 'subscriptions', label: 'Subscriptions', render: subscriptionsView },
  { id: 'client-apps', label: 'Client apps', render: clientAppsView },
  { id: 'backup', label: 'Backup', render: backupView },
  { id: 'settings', label: 'Settings', render: settingsView },
];

function loginScreen() {
  const email = emailInput({ placeholder: 'admin@strict.local', autocomplete: 'username' });
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
let sidebar = null;
let menuButton = null;

async function renderView(viewId) {
  const view = VIEWS.find((v) => v.id === viewId) ?? VIEWS[0];
  currentView = view.id;

  const main = document.getElementById('main');
  if (!main) return;

  // Reflect the active item before awaiting data.
  sidebar?.setActive(view.id);
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

/** Close the mobile drawer; safe to call on desktop. */
function closeDrawer() {
  document.body.classList.remove('nav-open');
  menuButton?.setAttribute('aria-expanded', 'false');
}

/** Two-letter monogram for the account card. */
function initials(email) {
  const local = String(email ?? '').split('@')[0].replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  const parts = local.split(/\s+/).filter(Boolean);
  const letters = parts.length > 1
    ? (parts[0][0] ?? '') + (parts[1][0] ?? '')
    : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

function shell(email) {
  const nav = createSidebar({
    views: VIEWS,
    activeId: currentView,
    onNavigate: (id) => { closeDrawer(); renderView(id); },
  });
  sidebar = nav;

  menuButton = h('button', {
    class: 'icon-btn menu-btn',
    type: 'button',
    'aria-label': 'Open navigation',
    'aria-controls': 'sidebar',
    'aria-expanded': 'false',
    onClick: () => {
      const open = document.body.classList.toggle('nav-open');
      menuButton.setAttribute('aria-expanded', String(open));
    },
  }, navIcon('menu', 'menu-ico'));

  const signOut = async () => {
    closeDrawer();
    sidebar = null;
    await api.logout();
    await boot();
  };

  mount(root,
    h('div', { class: 'shell' },
      h('header', { class: 'mobile-bar' },
        menuButton,
        h('span', { class: 'brand-logo' }, navIcon('shield', 'brand-ico')),
        h('span', { class: 'brand-name' }, 'StrictProxy'),
      ),
      h('aside', { class: 'sidebar', id: 'sidebar' },
        h('div', { class: 'brand' },
          h('span', { class: 'brand-logo' }, navIcon('shield', 'brand-ico')),
          h('div', { class: 'brand-text' },
            h('span', { class: 'brand-name' }, 'StrictProxy'),
            h('span', { class: 'brand-sub' }, 'Control plane'),
          ),
        ),
        nav.el,
        h('div', { class: 'spacer' }),
        h('div', { class: 'who' },
          h('div', { class: 'who-id' },
            h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(email)),
            h('div', { style: 'min-width:0' },
              h('span', { class: 'who-mail', title: email }, email),
              h('span', { class: 'who-role' }, 'Administrator'),
            ),
          ),
          h('button', {
            class: 'icon-btn',
            type: 'button',
            title: 'Sign out',
            'aria-label': 'Sign out',
            onClick: signOut,
          }, navIcon('logout', 'signout-ico')),
        ),
      ),
      h('div', { class: 'nav-backdrop', onClick: closeDrawer }),
      h('main', { class: 'main', id: 'main' }),
    ),
  );
}

document.addEventListener('keydown', (event) => {
  const target = event.target;
  const typing = target instanceof HTMLElement
    && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
      || target.tagName === 'SELECT' || target.isContentEditable);

  if (event.key === '/' && !typing) {
    event.preventDefault();
    sidebar?.focusSearch();
  }
  if (event.key === 'Escape') closeDrawer();
});

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
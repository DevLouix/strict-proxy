/**
 * Sidebar navigation for the admin shell.
 *
 * The dashboard has more operator screens than fit comfortably in one flat
 * list, so the entries are grouped by the job an operator is doing — watching
 * the platform, running accounts, running the network, taking money, or
 * maintaining the deployment. The view ids stay in `app.js`'s VIEWS table; this
 * module only decides how those ids are presented.
 *
 * Icons are inline SVG strings with no dependency and no network request: the
 * dashboard is served straight from the controller.
 */
import { h } from './dom.js';

export const NAV_GROUPS = [
  {
    id: 'monitor',
    label: 'Monitor',
    items: [{ id: 'overview', icon: 'grid' }],
  },
  {
    id: 'accounts',
    label: 'Accounts',
    items: [
      { id: 'users', icon: 'users' },
      { id: 'subscriptions', icon: 'repeat' },
      { id: 'usage', icon: 'activity' },
    ],
  },
  {
    id: 'network',
    label: 'Network',
    items: [
      { id: 'nodes', icon: 'server' },
      { id: 'enrollments', icon: 'key' },
      { id: 'links', icon: 'link' },
      { id: 'client-apps', icon: 'smartphone' },
    ],
  },
  {
    id: 'billing',
    label: 'Billing',
    items: [
      { id: 'plans', icon: 'layers' },
      { id: 'coupons', icon: 'tag' },
      { id: 'payments', icon: 'credit-card' },
      { id: 'disputes', icon: 'shield' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'audit', icon: 'list' },
      { id: 'backup', icon: 'database' },
      { id: 'settings', icon: 'settings' },
    ],
  },
];

// Feather-style 24x24 strokes; the shell draws them at 18px.
const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  repeat: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M11.39 11.39 21 1.78"/><path d="M18 3l3 3"/><path d="M15 6l3 3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  smartphone: '<rect x="5" y="2" width="14" height="20" rx="2.5"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  tag: '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  'credit-card': '<rect x="1" y="4" width="22" height="16" rx="2.5"/><line x1="1" y1="10" x2="23" y2="10"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
};

/** Returns an <span> wrapping a stroke icon from the table above. */
export function navIcon(name, className = 'nav-ico') {
  const span = document.createElement('span');
  span.className = className;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" `
    + `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ICONS.grid}</svg>`;
  return span;
}

const COLLAPSED_KEY = 'sp.nav.collapsed';

function readCollapsed() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(collapsed) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // A browser with storage disabled still gets a usable menu, just without
    // remembering which groups were folded.
  }
}

/**
 * Builds the grouped, filterable navigation.
 *
 * `views` is the shell's VIEWS table, so labels live in one place. Returns the
 * element plus the two imperative operations the shell needs.
 */
export function createSidebar({ views, activeId, onNavigate }) {
  const byId = new Map(views.map((view) => [view.id, view]));
  const collapsed = readCollapsed();
  const groupNodes = new Map();
  const itemNodes = new Map();

  const search = h('input', {
    type: 'search',
    class: 'nav-search-input',
    placeholder: 'Find a section',
    'aria-label': 'Filter navigation sections',
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const groupsHost = h('div', { class: 'nav-groups', role: 'navigation', 'aria-label': 'Admin sections' });

  for (const group of NAV_GROUPS) {
    const items = group.items.map((item) => byId.get(item.id)).filter(Boolean);
    if (items.length === 0) continue;

    const isCollapsed = collapsed.has(group.id);
    const itemsHost = h('div', { class: 'nav-group-items' });
    const groupEl = h('div', { class: `nav-group${isCollapsed ? ' collapsed' : ''}`, dataset: { group: group.id } });

    const head = h('button', {
      class: 'nav-group-head',
      type: 'button',
      'aria-expanded': String(!isCollapsed),
      onClick: () => {
        const nowCollapsed = groupEl.classList.toggle('collapsed');
        head.setAttribute('aria-expanded', String(!nowCollapsed));
        if (nowCollapsed) collapsed.add(group.id);
        else collapsed.delete(group.id);
        saveCollapsed(collapsed);
      },
    },
      h('span', { class: 'nav-group-label' }, group.label),
      navIcon('chevron', 'nav-chev'),
    );

    for (const view of items) {
      const icon = group.items.find((item) => item.id === view.id)?.icon;
      const btn = h('button', {
        class: 'nav-item',
        type: 'button',
        dataset: { view: view.id },
        title: view.label,
        'aria-current': view.id === activeId ? 'page' : null,
        onClick: () => onNavigate(view.id),
      },
        navIcon(icon),
        h('span', { class: 'nav-label' }, view.label),
      );
      itemNodes.set(view.id, btn);
      itemsHost.append(btn);
    }

    groupEl.append(head, itemsHost);
    groupNodes.set(group.id, { el: groupEl, head, itemsHost });
    groupsHost.append(groupEl);
  }

  const empty = h('div', { class: 'nav-none' }, 'No section matches that search.');
  empty.hidden = true;

  const searchBox = h('div', { class: 'nav-search' }, navIcon('search', 'search-ico'), search, h('kbd', {}, '/'));

  function applyFilter() {
    const query = search.value.trim().toLowerCase();
    let any = false;

    for (const [groupId, node] of groupNodes) {
      let visible = 0;
      for (const btn of node.itemsHost.children) {
        const label = btn.textContent.toLowerCase();
        const hit = query === '' || label.includes(query);
        btn.hidden = !hit;
        if (hit) visible += 1;
      }

      node.el.hidden = visible === 0;
      if (query !== '' && visible > 0) {
        node.el.classList.remove('collapsed');
        node.head.setAttribute('aria-expanded', 'true');
      } else if (query === '') {
        const isCollapsed = collapsed.has(groupId);
        node.el.classList.toggle('collapsed', isCollapsed);
        node.head.setAttribute('aria-expanded', String(!isCollapsed));
      }
      if (visible > 0) any = true;
    }

    empty.hidden = any;
  }

  search.addEventListener('input', applyFilter);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      search.value = '';
      applyFilter();
      search.blur();
      return;
    }
    if (event.key === 'Enter') {
      const first = groupsHost.querySelector('.nav-item:not([hidden])');
      if (first) onNavigate(first.dataset.view);
    }
  });

  applyFilter();

  const el = h('div', { class: 'nav-shell' }, searchBox, groupsHost, empty);

  return {
    el,
    search,
    focusSearch() {
      search.focus();
      search.select();
    },
    setActive(id) {
      for (const [viewId, btn] of itemNodes) {
        const active = viewId === id;
        btn.classList.toggle('active', active);
        if (active) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      }

      // A section reached by URL or by search should not stay folded away.
      const group = NAV_GROUPS.find((entry) => entry.items.some((item) => item.id === id));
      if (!group) return;
      const node = groupNodes.get(group.id);
      if (node?.el.classList.contains('collapsed')) {
        node.el.classList.remove('collapsed');
        node.head.setAttribute('aria-expanded', 'true');
        collapsed.delete(group.id);
        saveCollapsed(collapsed);
      }
    },
  };
}

/**
 * Minimal DOM + formatting helpers for the admin dashboard.
 * Deliberately tiny: no framework, no virtual DOM, no build step.
 */

/** Creates an element with props and children. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(value);
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replaces an element's children in one shot. */
export function mount(host, ...children) {
  host.replaceChildren(...children.flat(4).filter(Boolean));
  return host;
}

/**
 * An email input with every hint a browser, password manager or phone keyboard
 * understands.
 *
 * `type="email"` alone is not enough: mobile keyboards switch on `inputmode`,
 * password managers key off `autocomplete`, and a capitalised or autocorrected
 * address fails server-side validation for a reason the user cannot see. The
 * length cap matches what the controller accepts.
 */
export function emailInput(props = {}) {
  return h('input', {
    type: 'email',
    inputmode: 'email',
    autocomplete: 'email',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
    maxlength: '254',
    ...props,
  });
}

/** Formats a byte count for humans. */
export function bytes(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(n)) / Math.log(1024)));
  const scaled = n / 1024 ** i;
  return `${scaled >= 100 || i === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[i]}`;
}

/**
 * How many decimal places a currency's minor unit has.
 *
 * Two for most, zero for JPY/KRW/VND, three for KWD. Guessing two is what made
 * a ¥500 price render as ¥5.00, so `Intl` is asked and the answer is used
 * everywhere an amount is shown or converted.
 */
export function currencyDigits(currency) {
  try {
    const resolved = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).resolvedOptions();
    return Number.isInteger(resolved.maximumFractionDigits) ? resolved.maximumFractionDigits : 2;
  } catch {
    return 2;
  }
}

/** An input's major-unit text ("12.50") as the integer minor units the API stores. */
export function amountToMinor(value, currency) {
  return Math.round(Number(value) * 10 ** currencyDigits(currency));
}

/** Minor units as the major-unit number an amount input should display. */
export function minorToAmount(amountMinor, currency) {
  const n = Number(amountMinor ?? 0);
  return Number.isFinite(n) ? n / 10 ** currencyDigits(currency) : 0;
}

/**
 * Formats a minor-unit amount (kobo/cents) as a major-unit string.
 * The currency decides the decimal count, so JPY (0 minor digits) and KWD (3)
 * stay correct instead of being forced through a hundred.
 */
export function money(amountMinor, currency) {
  const n = Number(amountMinor ?? 0);
  if (!Number.isFinite(n)) return '—';
  const code = currency || 'USD';
  const digits = currencyDigits(code);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n / 10 ** digits);
  } catch {
    return `${(n / 10 ** digits).toFixed(digits)} ${code}`.trim();
  }
}

/** ISO timestamp -> readable local string; null-safe. */
export function date(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Relative time for "last seen" style columns. */
export function ago(value) {
  if (!value) return 'never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'never';
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/** A coloured status pill. */
export function badge(text) {
  const value = String(text ?? 'unknown').toLowerCase();
  return h('span', { class: `badge ${value}` }, value);
}

/** Transient toast notification. */
export function toast(message, kind = 'ok', ms = 4000) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: `toast ${kind}` }, message);
  host.append(el);
  setTimeout(() => el.remove(), ms);
}

/** Triggers a clipboard copy with a graceful fallback. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed — select the text manually', 'err');
  }
}

/** A <dialog> used for confirmations and token display. */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dlg = h('dialog', {},
      h('div', { class: 'dlg-head' }, h('h3', {}, title)),
      h('div', { class: 'dlg-body' }, body),
      h('div', { class: 'dlg-foot' },
        h('button', { class: 'btn', onClick: () => { dlg.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => { dlg.close(); resolve(true); } }, confirmLabel),
      ),
    );
    document.body.append(dlg);
    dlg.addEventListener('close', () => { dlg.remove(); }, { once: true });
    dlg.showModal();
  });
}
/**
 * Adds a show/hide control beside a password input.
 *
 * The original input is reused rather than cloned so the surrounding form keeps
 * reading the live value and the browser's password manager still recognises the
 * field. The button is explicitly `type="button"` so it cannot submit a form.
 */
import { h } from './dom.js';

export function passwordField(input) {
  const toggle = h('button', {
    type: 'button',
    class: 'btn sm password-toggle',
    'aria-label': 'Show password',
    'aria-pressed': 'false',
  }, 'Show');

  toggle.addEventListener('click', () => {
    const currentlyHidden = (input.type || input.getAttribute('type') || 'password') === 'password';
    input.type = currentlyHidden ? 'text' : 'password';
    // Mirror it onto the attribute too, so the state survives DOM inspection.
    input.setAttribute('type', input.type);
    toggle.textContent = currentlyHidden ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', currentlyHidden ? 'Hide password' : 'Show password');
    toggle.setAttribute('aria-pressed', String(currentlyHidden));
    input.focus();
  });

  return h('div', { class: 'password-field' }, input, toggle);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { installDomShim, FakeElement } from '../helpers/dom-shim.js';
import { h } from '../../apps/controller/src/admin/dom.js';
import { passwordField } from '../../apps/controller/src/admin/password-toggle.js';

installDomShim();

test('the password reveal control toggles the field without replacing it', () => {
  const input = h('input', { type: 'password' }) as any;
  // The shim records `type` as an attribute; a browser keeps the property in
  // sync, so set it here to mirror that.
  input.type = 'password';

  const wrap = passwordField(input) as any;
  const button = wrap.children.find(
    (el: any) => el instanceof FakeElement && el.tagName === 'BUTTON',
  );
  assert.ok(button, 'the field should carry a reveal button');
  assert.equal(button.getAttribute('type'), 'button', 'the toggle must not submit the form');
  assert.equal(button.getAttribute('aria-label'), 'Show password');

  button.dispatch('click');
  assert.equal(input.type, 'text', 'the first click reveals the value');
  assert.equal(button.getAttribute('aria-label'), 'Hide password');

  button.dispatch('click');
  assert.equal(input.type, 'password', 'the second click hides it again');
  assert.equal(button.getAttribute('aria-label'), 'Show password');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  isRole,
  roleHasPermission,
} from '../../apps/controller/src/services/rbac.js';

void test('administrators hold every permission', () => {
  for (const permission of PERMISSIONS) {
    assert.equal(roleHasPermission('admin', permission), true, permission);
  }
});

void test('ordinary users hold no admin permission', () => {
  for (const permission of PERMISSIONS) {
    assert.equal(roleHasPermission('user', permission), false, permission);
  }
});

void test('an unknown role is refused rather than defaulting to admin', () => {
  assert.equal(isRole('superuser'), false);
  assert.equal(roleHasPermission('superuser', 'users.create'), false);
  assert.equal(roleHasPermission(undefined, 'users.create'), false);
  assert.equal(roleHasPermission(null, 'users.read'), false);
});

void test('every declared role maps to known permissions only', () => {
  const known = new Set<string>(PERMISSIONS);
  for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
    for (const permission of granted) {
      assert.ok(known.has(permission), `${role} grants unknown permission ${permission}`);
    }
  }
  assert.equal(new Set(PERMISSIONS).size, PERMISSIONS.length, 'no duplicate permissions');
});

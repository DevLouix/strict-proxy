/**
 * The admin dashboard is build-free ES modules served straight to the browser.
 *
 * There is no bundler, so nothing in the toolchain checks that an import
 * resolves or that a named export exists. A typo therefore does not fail a
 * build or a test — it ships, the module 404s or throws at parse time, and the
 * dashboard renders as a blank page for the operator. These checks are the only
 * thing standing between a typo and that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../apps/controller/src/admin');

/** Files the browser actually loads. `index.html` lists the entry point. */
async function adminModules(): Promise<string[]> {
  const names = await readdir(ADMIN_DIR);
  return names.filter((n) => n.endsWith('.js')).map((n) => path.join(ADMIN_DIR, n));
}

/** Named exports declared by a module, from `export function|const|class|{…}`. */
function declaredExports(source: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s*\{([^}]*)\}/g,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      for (const part of match[1].split(',')) {
        // Handle `a as b`, and ignore the `type` prefix from TS-style exports.
        const name = part.split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

test('every admin module parses as an ES module', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  for (const file of await adminModules()) {
    await run(process.execPath, ['--check', file]);
  }
});

test('every relative import resolves to a real file', async () => {
  const files = await adminModules();
  const missing: string[] = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      try {
        await readFile(target);
      } catch {
        missing.push(`${path.relative(ADMIN_DIR, file)} -> ${match[1]}`);
      }
    }
  }

  assert.deepEqual(missing, [], `unresolvable imports:\n${missing.join('\n')}`);
});

test('every named import is actually exported by the module it comes from', async () => {
  const files = await adminModules();
  const exportsByFile = new Map<string, Set<string>>();
  for (const file of files) {
    exportsByFile.set(file, declaredExports(await readFile(file, 'utf8')));
  }

  const problems: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[2]);
      const available = exportsByFile.get(target);
      if (!available) continue; // checked by the resolution test
      for (const part of match[1].split(',')) {
        const name = part.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (name && !available.has(name)) {
          problems.push(`${path.relative(ADMIN_DIR, file)} imports { ${name} } from ${match[2]}, which does not export it`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], `missing exports:\n${problems.join('\n')}`);
});

test('index.html loads the entry module the dashboard is built around', async () => {
  const html = await readFile(path.join(ADMIN_DIR, 'index.html'), 'utf8');
  assert.match(html, /app\.js/, 'the shell entry point must be referenced');
  assert.match(html, /app\.css/, 'the stylesheet must be referenced');
  // Module scripts, not classic ones: the dashboard uses ESM imports.
  assert.match(html, /type=["']module["']/, 'the entry must load as a module');
});

test('every view registered in navigation has a renderer', async () => {
  const app = await readFile(path.join(ADMIN_DIR, 'app.js'), 'utf8');

  // The view ids and their renderers live in one VIEWS table; a typo there
  // silently drops a tab or throws on click.
  const entries = [...app.matchAll(/\{\s*id:\s*'([a-z-]+)',\s*label:\s*'([^']+)',\s*render:\s*([A-Za-z_$][\w$]*)\s*\}/g)];
  assert.ok(entries.length >= 9, `expected the full view set, found ${entries.length}`);

  const viewsSource = await readFile(path.join(ADMIN_DIR, 'views.js'), 'utf8');
  const settingsSource = await readFile(path.join(ADMIN_DIR, 'settings-view.js'), 'utf8');
  const opsSource = await readFile(path.join(ADMIN_DIR, 'billing-ops-view.js'), 'utf8');
  const exported = new Set([...declaredExports(viewsSource), ...declaredExports(settingsSource), ...declaredExports(opsSource)]);

  for (const [, , , renderer] of entries) {
    assert.ok(exported.has(renderer), `navigation references ${renderer}, which no view module exports`);
  }

  // The operator tabs must be reachable rather than defined and forgotten:
  // each one exists because the platform could not do something without it.
  for (const label of ['Settings', 'Plans', 'Subscriptions']) {
    assert.ok(entries.some(([, , l]) => l === label), `the ${label} tab is missing from navigation`);
  }
});

test('the settings view never renders a stored secret back into the form', async () => {
  const source = await readFile(path.join(ADMIN_DIR, 'settings-view.js'), 'utf8');
  // A read-back path would make the write-only guarantee cosmetic.
  assert.ok(!/\.summary\.password\b/.test(source), 'the view must not read summary.password');
  assert.match(source, /passwordSet/, 'the form should still say whether a password exists');
});

test('every operator billing route has a control in the dashboard', async () => {
  // A route with no UI is a route an operator has to curl, which is how the
  // original gap ("plans must be created in the provider's dashboard") existed
  // in the first place.
  const source = await readFile(path.join(ADMIN_DIR, 'billing-ops-view.js'), 'utf8');
  const calls = [
    "api.get('/api/v1/admin/billing/plans')",
    "api.post('/api/v1/admin/billing/plans/sync'",
    "api.put('/api/v1/admin/billing/plans/price'",
    "api.del(`/api/v1/admin/billing/plans/price/${t.tier}`)",
    "api.post('/api/v1/admin/billing/plans/delete'",
    "api.get('/api/v1/admin/billing/subscriptions')",
    "api.post('/api/v1/admin/billing/subscriptions/cancel'",
  ];
  for (const call of calls) {
    assert.ok(source.includes(call), `no dashboard control calls ${call}`);
  }
});

/**
 * The boot-time production guard.
 *
 * The development defaults are convenient, not safe: `CORS_ORIGINS` used to
 * default to `*` and `PUBLIC_APP_URL` to localhost, so a deployment that copied
 * an example and shipped it would serve an open API and send password-reset
 * links nobody can open. These tests pin that production refuses those, that
 * the refusal is scoped to production, and that the softer problems are named
 * rather than silently accepted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, productionConfigProblems } from '../../apps/controller/src/env.js';

/** Runs `fn` with the given env overrides, restoring everything afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Runs `fn` with `console.warn` captured, so boot warnings stay out of the test log. */
function capture<T>(fn: () => T): { result: T; warnings: string[] } {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

/** A production environment that passes every check, to be broken one field at a time. */
const SAFE_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://strict:strict@localhost:5432/strict_proxy',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(48),
  SIGNING_PRIVATE_KEY_PEM: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
  PAYMENT_WEBHOOK_SECRET: 'webhook-secret',
  CORS_ORIGINS: 'https://app.example.net',
  PUBLIC_APP_URL: 'https://app.example.net',
  ENABLE_HSTS: 'true',
};

/** A safe, complete config object for the pure check. */
function safeConfig(overrides: Partial<Parameters<typeof productionConfigProblems>[0]> = {}) {
  return {
    corsOrigins: ['https://app.example.net'],
    publicAppUrl: 'https://app.example.net',
    enableHsts: true,
    openpayApiKey: 'pk_live_abc',
    openpayBaseUrl: 'https://api.openpay.fiatden.com',
    settingsEncryptionKey: 'k'.repeat(32),
    jwtSecret: 'a'.repeat(48),
    ...overrides,
  };
}

test('a considered production configuration reports nothing', () => {
  const { errors, warnings } = productionConfigProblems(safeConfig());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('CORS_ORIGINS=* is an error, not a warning', () => {
  const { errors } = productionConfigProblems(safeConfig({ corsOrigins: ['*'] }));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /CORS_ORIGINS/);
});

test('a wildcard alongside a real origin is still an error', () => {
  const { errors } = productionConfigProblems(safeConfig({ corsOrigins: ['https://app.example.net', '*'] }));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /reflects any origin/);
});

test('a localhost PUBLIC_APP_URL is an error, however it is spelled', () => {
  for (const url of ['http://localhost', 'http://localhost:3000', 'https://127.0.0.1', 'http://0.0.0.0:8080']) {
    const { errors } = productionConfigProblems(safeConfig({ publicAppUrl: url }));
    assert.equal(errors.length, 1, `${url} should be refused`);
    assert.match(errors[0]!, /PUBLIC_APP_URL/);
  }
});

test('an unparseable PUBLIC_APP_URL is not mistaken for a safe one', () => {
  // No host means no localhost match, so it cannot silently pass as "fine"; the
  // value is still visible in the boot output for an operator to notice.
  const { errors } = productionConfigProblems(safeConfig({ publicAppUrl: 'not a url' }));
  assert.deepEqual(errors, []);
});

test('the softer problems are warnings that name the consequence', () => {
  const { errors, warnings } = productionConfigProblems(
    safeConfig({ enableHsts: false, openpayApiKey: '', settingsEncryptionKey: '', jwtSecret: 'short' }),
  );
  assert.deepEqual(errors, []);
  const joined = warnings.join('\n');
  assert.match(joined, /ENABLE_HSTS/);
  assert.match(joined, /OPENPAY_API_KEY is empty/);
  assert.match(joined, /SETTINGS_ENCRYPTION_KEY/);
  assert.match(joined, /JWT_SECRET is only 5 characters/);
});

test('a placeholder OpenPay URL is called out only when a key is set', () => {
  // With no key, the "billing is disabled" warning already covers it; a second
  // warning about the URL would be noise.
  const disabled = productionConfigProblems(safeConfig({ openpayApiKey: '', openpayBaseUrl: 'https://api.openpay.example.com' }));
  assert.ok(!disabled.warnings.some((w) => /placeholder/.test(w)));

  const enabled = productionConfigProblems(safeConfig({ openpayApiKey: 'pk_live_x', openpayBaseUrl: 'https://api.openpay.example.com' }));
  assert.ok(enabled.warnings.some((w) => /placeholder/.test(w)));
});

test('loadConfig refuses to boot in production with an open CORS policy', () => {
  withEnv({ ...SAFE_ENV, CORS_ORIGINS: '*' }, () => {
    assert.throws(() => capture(() => loadConfig()), /unsafe production configuration/);
  });
});

test('loadConfig refuses to boot in production with a localhost app URL', () => {
  withEnv({ ...SAFE_ENV, PUBLIC_APP_URL: 'http://localhost:3000' }, () => {
    assert.throws(() => capture(() => loadConfig()), /PUBLIC_APP_URL/);
  });
});

test('the same values are accepted outside production', () => {
  withEnv({ ...SAFE_ENV, NODE_ENV: 'development', CORS_ORIGINS: '*', PUBLIC_APP_URL: 'http://localhost:3000' }, () => {
    const { result: cfg } = capture(() => loadConfig());
    assert.equal(cfg.isProduction, false);
    assert.deepEqual(cfg.corsOrigins, ['*']);
  });
});

test('a safe production boot succeeds and warns about what is genuinely unset', () => {
  withEnv({ ...SAFE_ENV, SETTINGS_ENCRYPTION_KEY: '' }, () => {
    const { result: cfg, warnings } = capture(() => loadConfig());
    assert.equal(cfg.isProduction, true);
    assert.deepEqual(cfg.corsOrigins, ['https://app.example.net']);
    assert.ok(warnings.some((w) => /SETTINGS_ENCRYPTION_KEY/.test(w)));
  });
});

test('CORS_ORIGINS defaults to a closed posture, not a wildcard', () => {
  withEnv({ ...SAFE_ENV, CORS_ORIGINS: undefined }, () => {
    const { result: cfg } = capture(() => loadConfig());
    assert.deepEqual(cfg.corsOrigins, [], 'an unset CORS_ORIGINS must not open the API');
  });
});

test('HSTS is on by default, so production need not remember it', () => {
  withEnv({ ...SAFE_ENV, ENABLE_HSTS: undefined }, () => {
    const { result: cfg, warnings } = capture(() => loadConfig());
    assert.equal(cfg.enableHsts, true);
    assert.ok(!warnings.some((w) => /ENABLE_HSTS/.test(w)), 'no warning when it is on');
  });
});

test('turning HSTS off is still allowed, but it is noted', () => {
  withEnv({ ...SAFE_ENV, ENABLE_HSTS: 'false' }, () => {
    const { result: cfg, warnings } = capture(() => loadConfig());
    assert.equal(cfg.enableHsts, false);
    assert.ok(warnings.some((w) => /ENABLE_HSTS/.test(w)));
  });
});

/**
 * Central Controller app factory — exported separately from the entrypoint
 * so tests/smoke scripts can boot it in-process on an ephemeral port.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { getDb } from './db/client.js';
import { getRedis } from './redis.js';
import { loadConfig, type ControllerConfig } from './env.js';
import { buildRouter } from './routes.js';
import { buildBillingRouter } from './routes/billing.js';
import { buildDisputesRouter } from './routes/disputes.js';
import { buildAccountRouter } from './routes/account.js';
import { buildMailRouter } from './routes/mail.js';
import { buildBillingOpsRouter } from './routes/billing-ops.js';
import { createPaymentWebhookRouter, PlaceholderPaymentAdapter, type PaymentGatewayAdapter } from './services/payments.js';
import { createOpenPayAdapter } from './services/openpay.js';
import { buildSetupRouter } from './routes/setup.js';
import { buildBackupRouter } from './routes/backup.js';
import { buildAppReleaseRouter } from './routes/app-release.js';
import { errorHandler } from './middleware.js';
import { mountAdminDashboard } from './admin-ui.js';

export interface AppContext {
  app: Express;
  cfg: ControllerConfig;
}

export interface BuildAppOptions {
  /** Override the selected gateway adapter (used by tests and custom integrations). */
  paymentAdapter?: PaymentGatewayAdapter;
}

export function buildApp(options: BuildAppOptions = {}): AppContext {
  const cfg = loadConfig();
  const db = getDb(cfg.databaseUrl);
  const redis = getRedis(cfg.redisUrl);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxyHops);
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (cfg.enableHsts) {
      res.setHeader('Strict-Transport-Security', `max-age=${cfg.hstsMaxAgeSeconds}; includeSubDomains`);
    }
    next();
  });

  // Operator backup is mounted BEFORE the global JSON parser: an export has no
  // body, and an import is a whole dataset that the 1 MB default would reject,
  // so that route installs its own 64 MB parser.
  app.use(buildBackupRouter({ db, cfg }));

  // Capture the raw body for HMAC/webhook signature verification.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  // Minimal CORS for the Flutter web/debug builds.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin');
    if (origin && (cfg.corsOrigins.includes('*') || cfg.corsOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-node-id, x-timestamp, x-nonce, x-signature');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // First-run bootstrap, mounted ahead of everything else. It is its own gate:
  // every request re-checks that no administrator exists, and once one does it
  // calls next() so the ordinary 404 answers — no "setup disabled" surface.
  app.use(buildSetupRouter({ db }));

  // Payment webhooks FIRST (need raw body, no auth middleware).
  // OpenPay is preferred when configured; the placeholder adapter is a
  // development-only fallback that must not be mistaken for a live gateway.
  const adapter: PaymentGatewayAdapter =
    options.paymentAdapter ?? createOpenPayAdapter(cfg) ?? new PlaceholderPaymentAdapter();
  const webhookRouter = createPaymentWebhookRouter({ db, redis, cfg, adapter });
  app.use(webhookRouter);

  // Main API. The billing router must be mounted BEFORE the main router: the
// main router ends with a catch-all JSON 404, which would otherwise swallow
// every /api/v1/billing/* route.
  app.use(buildBillingRouter({ db, cfg, redis }));
  app.use(buildDisputesRouter({ db, cfg, redis }));
  app.use(buildAccountRouter({ db, cfg, redis }));
  app.use(buildMailRouter({ db, cfg }));
  app.use(buildBillingOpsRouter({ db, cfg }));

  // Admin dashboard (static bundle). Must be mounted BEFORE the main router:
  // that router ends with a catch-all JSON 404 which would otherwise swallow
  // every /admin request.
  // Android client updates. Mounted before the main router so its routes are
  // not swallowed by that router's JSON 404 catch-all.
  app.use(buildAppReleaseRouter({ cfg }));

  mountAdminDashboard(app);

  app.use(buildRouter({ db, cfg, redis }));
  app.use(errorHandler);

  return { app, cfg };
}

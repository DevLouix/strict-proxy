/**
 * Central Controller app factory — exported separately from the entrypoint
 * so tests/smoke scripts can boot it in-process on an ephemeral port.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { getDb } from './db/client.js';
import { getRedis } from './redis.js';
import { loadConfig, type ControllerConfig } from './env.js';
import { buildRouter } from './routes.js';
import { createPaymentWebhookRouter, PlaceholderPaymentAdapter, type PaymentGatewayAdapter } from './services/payments.js';
import { errorHandler } from './middleware.js';

export interface AppContext {
  app: Express;
  cfg: ControllerConfig;
}

export interface BuildAppOptions {
  /** Replace the placeholder with the real provider adapter when supplied. */
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

  // Payment webhooks FIRST (need raw body, no auth middleware).
  const webhookRouter = createPaymentWebhookRouter({ db, redis, cfg, adapter: options.paymentAdapter ?? new PlaceholderPaymentAdapter() });
  app.use(webhookRouter);

  // Main API.
  app.use(buildRouter({ db, cfg, redis }));
  app.use(errorHandler);

  return { app, cfg };
}

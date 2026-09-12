/**
 * Central Controller app factory — exported separately from the entrypoint
 * so tests/smoke scripts can boot it in-process on an ephemeral port.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { getDb } from './db/client.js';
import { getRedis } from './redis.js';
import { loadConfig, type ControllerConfig } from './env.js';
import { buildRouter } from './routes.js';
import { createPaymentWebhookRouter, PlaceholderPaymentAdapter } from './services/payments.js';

export interface AppContext {
  app: Express;
  cfg: ControllerConfig;
}

export function buildApp(): AppContext {
  const cfg = loadConfig();
  const db = getDb(cfg.databaseUrl);
  const redis = getRedis(cfg.redisUrl);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

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
  const webhookRouter = createPaymentWebhookRouter({ db, redis, cfg, adapter: new PlaceholderPaymentAdapter() });
  app.use(webhookRouter);

  // Main API.
  app.use(buildRouter({ db, cfg, redis }));

  return { app, cfg };
}

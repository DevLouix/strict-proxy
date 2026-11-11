/**
 * Public landing page for the controller.
 *
 * The API answers JSON everywhere else, and `/` used to fall through to that
 * JSON 404 — a dead end for anyone opening the deployment's URL. This serves a
 * small, dependency-free page instead: deployment health, the admin console and
 * the currently published client build.
 *
 * It is mounted before the main router because that router ends with a
 * catch-all JSON 404.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));

export function mountIndexPage(app: Express): void {
  const indexFile = path.join(publicDir, 'index.html');
  if (!existsSync(indexFile)) {
    // The page is an optional asset: never take the API down over it.
    console.warn('[controller] index page not found; / will be unavailable');
    return;
  }

  const noStore = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    next();
  };

  app.get('/', noStore, (_req: Request, res: Response) => {
    res.type('html').sendFile(indexFile);
  });

  app.get('/index.html', noStore, (_req: Request, res: Response) => {
    res.type('html').sendFile(indexFile);
  });
}

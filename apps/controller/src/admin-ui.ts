/**
 * Admin dashboard: a dependency-free single-page app served as static files.
 *
 * No bundler is involved on purpose — the controller image already ships the
 * TypeScript sources and runs them through tsx, so adding a frontend toolchain
 * would add a build step, a supply chain and a failure mode for a page whose
 * whole job is a handful of forms over the existing admin REST API.
 *
 * Security model:
 *   - The static bundle contains no secrets and no inline data.
 *   - Every read and write goes through the admin REST API, which requires a
 *     JWT *and* the `admin` role. The UI is a convenience, not the boundary.
 *   - Tokens are held in sessionStorage (cleared when the tab closes) and are
 *     never written to a cookie, so an XSS cannot exfiltrate them via a
 *     subrequest the way it could with a cookie.
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const adminDir = fileURLToPath(new URL('./admin/', import.meta.url));

/**
 * Mounts the dashboard at `/admin`.
 *
 * `index.html` is served with no-store so a redeploy is picked up immediately;
 * hashed assets do not exist here, so everything is revalidated.
 */
export function mountAdminDashboard(app: Express): void {
  if (!existsSync(path.join(adminDir, 'index.html'))) {
    // The bundle is an optional asset: never take the API down over it.
    console.warn('[controller] admin dashboard bundle not found; /admin will be unavailable');
    return;
  }

  const noStore = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  };

  app.use('/admin', noStore, express.static(adminDir, { index: false, redirect: false, etag: true }));

  // Convenience redirect so /admin lands on the app.
  app.get('/admin', noStore, (_req: Request, res: Response) => {
    res.sendFile(path.join(adminDir, 'index.html'));
  });

  // Unknown /admin paths fall back to the app shell (client-side routing).
  // Express 4 uses a bare wildcard segment.
  app.get('/admin/*', noStore, (_req: Request, res: Response) => {
    res.sendFile(path.join(adminDir, 'index.html'));
  });
}
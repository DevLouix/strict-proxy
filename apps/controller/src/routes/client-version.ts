/**
 * Admin control for the minimum client build allowed to connect.
 *
 * Separate from the mail settings router because the value is enforced on the
 * client data path, not used for outbound mail; keeping it here makes the one
 * stored key and its two endpoints easy to audit.
 */
import { Router, type Request, type Response } from 'express';
import { asyncHandler, requireAdmin, requireJwt } from '../middleware.js';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { minimumClientBuild, setMinimumClientBuild } from '../services/client-version.js';

export function buildClientVersionRouter({ db, cfg }: { db: Db; cfg: ControllerConfig }): Router {
  const router = Router();
  const requireAdministrator = [requireJwt(cfg, db), requireAdmin];

  /** Current gate. `minimumBuild: null` means every build is allowed. */
  router.get(
    '/api/v1/admin/settings/client',
    ...requireAdministrator,
    asyncHandler(async (_req: Request, res: Response) => {
      const minimumBuild = await minimumClientBuild(db, cfg);
      res.setHeader('cache-control', 'no-store');
      res.json({ minimumBuild, enabled: minimumBuild !== null });
    }),
  );

  /**
   * Sets or clears the gate.
   *
   * `0`, `null` or a blank value disables it, which is the only way to undo a
   * minimum that was set too high. Validation happens before the write so a
   * typo cannot leave the network half-closed to clients.
   */
  router.put(
    '/api/v1/admin/settings/client',
    ...requireAdministrator,
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as { minimumBuild?: unknown };
      const raw = body.minimumBuild;

      let minimumBuild: number | null;
      if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') {
        minimumBuild = null;
      } else {
        const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);
        if (!Number.isSafeInteger(value) || value < 1) {
          res.status(400).json({
            error: 'minimumBuild must be a positive integer (the APK build number), or 0 to allow every build',
            code: 'VALIDATION',
          });
          return;
        }
        minimumBuild = value;
      }

      await setMinimumClientBuild(db, cfg, minimumBuild, req.auth!.sub);
      res.json({ ok: true, minimumBuild, enabled: minimumBuild !== null });
    }),
  );

  return router;
}

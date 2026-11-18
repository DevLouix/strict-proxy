/**
 * Role-based access control for the admin control plane.
 *
 * The controller used to answer "may this caller do this?" with the same
 * `role === 'admin'` comparison in every handler. That works for two roles but
 * hides the actual question — which operation is being authorised — inside
 * route prefixes. Here the operations are named, each role's grants live in one
 * table, and the middleware fails closed: an unknown role or permission is
 * refused rather than allowed through a default.
 *
 * Adding a role is one entry in [ROLE_PERMISSIONS]. Adding an operation is one
 * permission plus the route that asks for it; nothing else changes.
 */
import type { Request, Response, NextFunction } from 'express';
import { requireJwt } from '../middleware.js';
import type { ControllerConfig } from '../env.js';
import type { Db } from '../db/client.js';

export const PERMISSIONS = [
  'users.read',
  'users.create',
  'users.update',
  'users.subscription',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = 'admin' | 'user';

/**
 * What each role may do.
 *
 * Administrators hold every permission. An ordinary account holds none of the
 * admin control plane: its access is the public client API, which is authorised
 * by its own subscription and session checks.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  user: [],
};

/** True for a role the controller knows how to authorise. */
export function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'user';
}

/**
 * Whether [role] holds [permission].
 *
 * Deliberately does not default to true for an unrecognised role: a token with
 * a role this build does not know must not inherit administrator access.
 */
export function roleHasPermission(role: string | null | undefined, permission: Permission): boolean {
  if (!isRole(role)) return false;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Requires a valid JWT whose role holds [permission].
 *
 * Composes [requireJwt] so the disabled-account and revoked-session checks are
 * the same as everywhere else; this only adds the authorisation decision.
 */
export function requirePermission(cfg: ControllerConfig, db: Db, permission: Permission) {
  const authenticate = requireJwt(cfg, db);
  return (req: Request, res: Response, next: NextFunction): void => {
    authenticate(req, res, () => {
      if (!roleHasPermission(req.auth?.role, permission)) {
        res.status(403).json({ error: `permission ${permission} required`, code: 'FORBIDDEN' });
        return;
      }
      next();
    });
  };
}

/**
 * @strict-proxy/gatekeeper — Official StrictProxy Gatekeeper SDK for Node.js & TypeScript.
 *
 * Protect any web app or API so only users connected through your StrictProxy
 * fleet (and optionally holding a paid plan) can access it.
 */
export {
  Gatekeeper,
  TIER_RANK,
  clientIpOf,
  createGatekeeperMiddleware,
  entitlementTokenOf,
  entitlementTokenWithSourceOf,
  formatFetchError,
  safeReturnPath,
  tierSatisfies,
  verifyEntitlementToken,
} from './gatekeeper.js';

export {
  canonicalJson,
  loadSigningPublicKey,
  normalizePem,
  validatePublicKeyPem,
  verifyJson,
} from './crypto.js';

export type {
  AuthAllowedDecision,
  AuthDecision,
  AuthDeniedDecision,
  AuthInput,
  DenialReason,
  DenyResponseConfig,
  EntitlementClaims,
  EntitlementIdentity,
  EntitlementRejectReason,
  EntitlementTokenSource,
  EntitlementVerification,
  ExpressLikeMiddleware,
  ExpressLikeNext,
  ExpressLikeRequest,
  ExpressLikeResponse,
  GatekeeperAuthMode,
  GatekeeperBootstrapResponse,
  GatekeeperInitOptions,
  GatekeeperOptions,
  GatekeeperRouteOptions,
  GatekeeperStatus,
  PassHandoffOptions,
  PassHandoffResult,
  PublicIpsResponse,
  PublicKeyResponse,
  RefreshOptions,
  SubscriptionTier,
} from './types.js';

import type { EntitlementIdentity } from './types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Present when the Gatekeeper middleware verified a signed entitlement token. */
      strictProxy?: EntitlementIdentity;
    }
  }
}

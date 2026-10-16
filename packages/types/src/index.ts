/**
 * Shared domain types for the strict-proxy platform.
 * Consumed by the Central Controller, Node Agent, Gatekeeper SDK and the
 * Flutter client (via the controller's REST API shapes).
 */

// ---------------------------------------------------------------------------
// Subscription tiers
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_TIERS = ['free', 'standard', 'pro'] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export interface TierDefinition {
  tier: SubscriptionTier;
  /** Max concurrent VPN sessions (device seats). */
  deviceSeats: number;
  /** Max simultaneous node connections per session. */
  maxNodes: number;
  /** Monthly bandwidth quota in bytes; null = unlimited. */
  bandwidthQuotaBytes: number | null;
}

// ---------------------------------------------------------------------------
// Users & auth
// ---------------------------------------------------------------------------

export type UserRole = 'user' | 'admin';

export interface UserPublic {
  id: string;
  email: string;
  role: UserRole;
  tier: SubscriptionTier;
  tierExpiresAt: string | null;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime in seconds. */
  expiresIn: number;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  /** Opaque device identifier generated client-side (persisted per install). */
  deviceId: string;
  /** Human-friendly device label shown in the seat manager. */
  deviceName?: string;
}

export interface RefreshRequest {
  refreshToken: string;
  deviceId: string;
}

// ---------------------------------------------------------------------------
// Node fleet
// ---------------------------------------------------------------------------

export type NodeStatus = 'online' | 'degraded' | 'offline' | 'draining';

export interface NodeLoadReport {
  cpuPercent: number;
  memoryPercent: number;
  /** Bandwidth used by the node in the current reporting window, in bytes. */
  bandwidthBytes: number;
  /** Reported upstream RTT of the node itself in milliseconds. */
  uplinkRttMs: number;
  /** Uptime in seconds. */
  uptimeSeconds: number;
  /** Version of the sing-box engine running on the node. */
  engineVersion: string;
}

export interface FleetNode {
  id: string;
  hostname: string;
  region: string;
  /** Optional admin-defined display label, e.g. "Frankfurt 1". */
  label?: string | null;
  /** Public IPv4 of the exit node. */
  publicIp: string;
  status: NodeStatus;
  /** 0..100 normalized load score used for client-side sorting. */
  loadScore: number;
  lastHeartbeatAt: string | null;
}

/** Authenticated view of a node (includes connection endpoint). */
export interface NodeEndpoint {
  id: string;
  hostname: string;
  region: string;
  /** Optional admin-defined display label, e.g. "Frankfurt 1". */
  label?: string | null;
  publicIp: string;
  status: NodeStatus;
  loadScore: number;
  /** Host:port the client should dial for the tunnel. */
  tunnelHost: string;
  tunnelPort: number;
}

// ---------------------------------------------------------------------------
// Dynamic config (VLESS + REALITY)
// ---------------------------------------------------------------------------

export type TunnelProtocol = 'vless-reality';

/** Client-side sing-box outbound configuration, signed by the controller. */
export interface VlessRealityClientConfig {
  protocol: TunnelProtocol;
  /** VLESS UUID provisioned for (user, node) pair. */
  uuid: string;
  server: string;
  serverPort: number;
  /** SNI presented during the REALITY handshake. */
  serverName: string;
  /** Server's REALITY short-id for this user. */
  shortId: string;
  /** Server's REALITY public key. */
  publicKey: string;
  /** Flow control, e.g. xtls-rprx-vision. */
  flow: string;
  /** Fingerprint for uTLS client hello. */
  fingerprint: string;
  /** The network transport, always 'tcp' for REALITY. */
  transport: 'tcp';
}

/** Signed dynamic configuration bundle handed to the client. */
export interface SignedConfigBundle {
  /** ISO timestamp after which clients must re-fetch. */
  expiresAt: string;
  /** Ed25519 signature (base64) over the canonical config JSON. */
  signature: string;
  /** Ed25519 public key id used for the signature (key rotation support). */
  keyId: string;
  /** Per-node client configs. */
  nodes: NodeEndpoint[];
  /** Rendered sing-box outbound config per node id. */
  configs: Record<string, VlessRealityClientConfig>;
}

// ---------------------------------------------------------------------------
// Node <-> Controller internal API (HMAC-authenticated)
// ---------------------------------------------------------------------------

export interface NodeRegistrationRequest {
  hostname: string;
  region: string;
  publicIp: string;
  /** Listen port for VLESS+REALITY on the node. */
  tunnelPort: number;
  /** REALITY server private key (x25519). */
  realityPrivateKey: string;
  /** REALITY short-id list the node will accept. */
  realityShortIds: string[];
  /** sing-box engine version. */
  engineVersion: string;
}

export interface NodeRegistrationResponse {
  nodeId: string;
  /** HMAC secret used for subsequent internal API calls. */
  hmacSecret: string;
}

export interface NodeCredentialSet {
  /** VLESS UUID. */
  uuid: string;
  /** REALITY short-id assigned to this user on this node. */
  shortId: string;
  /** Email/handle for auditing. */
  userEmail: string;
  /** ISO timestamp when this credential stops being valid (null = none). */
  expiresAt: string | null;
  /** true when the credential must be removed from the node. */
  revoked: boolean;
}

export interface NodeSyncResponse {
  /** Full desired state: all non-revoked credentials valid right now. */
  credentials: NodeCredentialSet[];
  /** Server time for drift detection. */
  controllerTime: string;
}

// ---------------------------------------------------------------------------
// Gatekeeper SDK <-> Controller
// ---------------------------------------------------------------------------

export interface PublicIpsResponse {
  /** Ed25519 signature over canonical JSON of `ips` + `generatedAt`. */
  signature: string;
  keyId: string;
  generatedAt: string;
  /** ISO timestamp after which the consumer must refetch. */
  expiresAt: string;
  ips: string[];
}

// ---------------------------------------------------------------------------
// Payments (gateway-agnostic; concrete adapter injected later)
// ---------------------------------------------------------------------------

export type PaymentEventType =
  | 'checkout.completed'
  | 'subscription.deleted'
  | 'invoice.payment_failed'
  /** The bank or provider took the money back (chargeback opened). */
  | 'charge.disputed'
  /** The charge was reversed outright by the provider. */
  | 'charge.reversed';

export interface PaymentEvent {
  /** Provider-agnostic unique event id (idempotency key). */
  id: string;
  type: PaymentEventType;
  /** Provider's customer reference, mapped to our user via billing table. */
  providerCustomerId: string | null;
  /** Provider's subscription reference, if applicable. */
  providerSubscriptionId: string | null;
  /**
   * Hint identifying the local user this event concerns, when the provider
   * echoed it back (we stamp `metadata.user_id` on every checkout we open).
   * Resolution still falls back to provider references and the checkout
   * ledger, so this is an optimisation rather than a trust boundary.
   */
  userId?: string | null;
  /** Tier to grant on checkout completion. */
  tier: SubscriptionTier | null;
  /** Subscription period end (ISO) when extending access. */
  currentPeriodEnd: string | null;
  /** Raw provider payload retained for audit/debugging. */
  raw: unknown;
}

/** Result of applying a payment event to a user's subscription. */
export interface PaymentEventResult {
  applied: boolean;
  reason?: 'unknown_customer' | 'duplicate_event' | 'unknown_event_type' | 'already_active' | 'free_tier_not_purchasable';
  userId?: string;
  tier?: SubscriptionTier;
  tierExpiresAt?: string | null;
}

/** Minor-unit amounts are integers (kobo for NGN, cents for USD). */
export interface TierPrice {
  /** Charge amount in the currency's minor unit. */
  amountMinor: number;
  /** ISO 4217 code. */
  currency: string;
  /** Human label shown on the checkout. */
  label: string;
}

/** A checkout the controller opened with the provider, awaiting settlement. */
export interface BillingCheckoutPublic {
  reference: string;
  checkoutUrl: string;
  tier: SubscriptionTier;
  amountMinor: number;
  currency: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Wire shapes for client API
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}

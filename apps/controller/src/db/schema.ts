/**
 * Postgres schema for the Central Controller.
 *
 * Design notes:
 * - Users never touch nodes directly; access is mediated by `node_credentials`
 *   rows (one VLESS UUID + REALITY short-id per user per node).
 * - `payment_events` is the idempotency ledger for gateway webhooks.
 * - The active Ed25519 signing key lives in the environment
 *   (`SIGNING_PRIVATE_KEY_PEM` + `SIGNING_KEY_ID`); public artifacts carry the
 *   key id so consumers can verify during a rotation. There is deliberately no
 *   signing-keys table: a database-stored private half that the signing path
 *   never reads can silently diverge from the key consumers were configured
 *   with.
 */
import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, bigint } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('user'), // 'user' | 'admin'
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_uq').on(t.email)],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Client-generated opaque id, stable per install. */
    deviceId: text('device_id').notNull(),
    deviceName: text('device_name'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('devices_user_device_uq').on(t.userId, t.deviceId)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceRowId: uuid('device_row_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque refresh token; raw token never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash), index('refresh_tokens_user_idx').on(t.userId)],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: text('tier').notNull().default('free'), // 'free' | 'standard' | 'pro'
    /** 'active' | 'expired' | 'revoked' */
    status: text('status').notNull().default('active'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    /** Payment provider discriminator, set by the active adapter (e.g. 'openpay'). */
    provider: text('provider'),
    providerCustomerId: text('provider_customer_id'),
    providerSubscriptionId: text('provider_subscription_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('subscriptions_user_uq').on(t.userId), index('subscriptions_provider_customer_idx').on(t.providerCustomerId)],
);

/**
 * Hosted checkouts the controller opened with the payment provider.
 *
 * This is the durable link between a provider event and a local user: it
 * survives providers that drop the metadata we attach, and it records what was
 * actually offered so the audit trail does not depend on provider retention.
 * Entitlement is granted by the verified webhook, never by this row.
 */
export const billingCheckouts = pgTable(
  'billing_checkouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Our idempotent handle, stamped into provider metadata and echoed back. */
    reference: text('reference').notNull(),
    /** The provider-assigned reference for the session, when returned. */
    providerReference: text('provider_reference'),
    /** Provider-side checkout session id. */
    sessionId: text('session_id'),
    tier: text('tier').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    /** 'open' | 'paid' | 'expired' | 'failed' */
    status: text('status').notNull().default('open'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('billing_checkouts_reference_uq').on(t.reference),
    index('billing_checkouts_provider_ref_idx').on(t.providerReference),
    index('billing_checkouts_user_idx').on(t.userId),
    index('billing_checkouts_status_idx').on(t.status),
  ],
);

export const paymentEvents = pgTable('payment_events', {
  /** Provider-agnostic event id; webhook replays hit the PK and are skipped. */
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  applied: boolean('applied').notNull().default(false),
  reason: text('reason'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hostname: text('hostname').notNull(),
    region: text('region').notNull(),
    label: text('label'),
    publicIp: text('public_ip').notNull(),
    /**
     * How `public_ip` was last written: 'enrollment' (operator supplied it at
     * enrollment), 'autodetect' (the node reported it, or it was derived from
     * the enrollment connection), or 'manual' (an admin edited the node).
     * Surfaced so an address that moved on its own is visible in the dashboard.
     */
    publicIpSource: text('public_ip_source').notNull().default('enrollment'),
    publicIpUpdatedAt: timestamp('public_ip_updated_at', { withTimezone: true }).notNull().defaultNow(),
    tunnelPort: integer('tunnel_port').notNull().default(443),
    /** 'online' | 'degraded' | 'offline' | 'draining' */
    status: text('status').notNull().default('offline'),
    loadScore: integer('load_score').notNull().default(0),
    /** REALITY server private key (x25519, base64url). Secret: never leaves internal API. */
    realityPrivateKey: text('reality_private_key').notNull(),
    realityPublicKey: text('reality_public_key').notNull(),
    /** SNI clients must present for the REALITY handshake. */
    realityServerName: text('reality_server_name').notNull(),
    /** Accepted short-ids; per-user short-ids are drawn from this pool. */
    realityShortIds: jsonb('reality_short_ids').$type<string[]>().notNull(),
    engineVersion: text('engine_version').notNull().default('unknown'),
    /** HMAC secret for internal node API calls. Issued at registration. */
    hmacSecret: text('hmac_secret').notNull(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('nodes_hostname_uq').on(t.hostname), index('nodes_status_idx').on(t.status)],
);

/** One-time, short-lived credentials used to enroll a VPS node. */
export const nodeEnrollments = pgTable(
  'node_enrollments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    region: text('region').notNull(),
    label: text('label'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('node_enrollments_token_hash_uq').on(t.tokenHash), index('node_enrollments_expiry_idx').on(t.expiresAt)],
);


export const nodeCredentials = pgTable(
  'node_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    /** VLESS UUID (client identity). */
    uuid: text('uuid').notNull(),
    /** REALITY short-id assigned to this user on this node. */
    shortId: text('short_id').notNull(),
    flow: text('flow').notNull().default('xtls-rprx-vision'),
    revoked: boolean('revoked').notNull().default(false),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Bandwidth accounting for the current period (bytes), updated by nodes. */
    bytesUsed: bigint('bytes_used', { mode: 'number' }).notNull().default(0),
  },
  (t) => [uniqueIndex('node_credentials_user_node_uq').on(t.userId, t.nodeId), uniqueIndex('node_credentials_uuid_uq').on(t.uuid)],
);

/** Interval-based bandwidth rollups reported by nodes (per credential). */
export const usageRollups = pgTable(
  'usage_rollups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => nodeCredentials.id, { onDelete: 'cascade' }),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    bytesUp: bigint('bytes_up', { mode: 'number' }).notNull().default(0),
    bytesDown: bigint('bytes_down', { mode: 'number' }).notNull().default(0),
  },
  (t) => [index('usage_rollups_credential_idx').on(t.credentialId, t.windowStart), uniqueIndex('usage_rollups_window_uq').on(t.credentialId, t.windowStart, t.windowEnd)],
);

/**
 * Single-use password reset tokens.
 *
 * Only the SHA-256 hash is stored, matching refresh-token handling. Tokens
 * expire quickly and are consumed on first use, so an intercepted reset link
 * cannot be replayed.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** Admin who issued it, for operator-mediated recovery. Null = self-service. */
    issuedBy: uuid('issued_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('password_reset_tokens_hash_uq').on(t.tokenHash), index('password_reset_tokens_user_idx').on(t.userId)],
);

/**
 * Operator-editable platform settings, keyed by name.
 *
 * Generic on purpose: SMTP today, anything else tomorrow, without a migration
 * each time. Secret values (currently the SMTP password) are encrypted at rest
 * and tagged with an `enc:v1:` prefix so a setting can move between secret and
 * plain without ambiguity. See `services/settings.ts`.
 */
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  /**
   * Encrypted ciphertext for secrets, plaintext otherwise. `enc:v1:<iv>:<tag>:<data>`
   * when secret; JSON-encoded for structured values.
   */
  value: text('value').notNull(),
  /** Marks values that must never be returned by the API. */
  isSecret: boolean('is_secret').notNull().default(false),
  /** Admin who last wrote it. */
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** JWT ID set for access-token revocation lists (post-logout invalidation). */
export const revokedAccessTokens = pgTable('revoked_access_tokens', {
  jti: text('jti').primaryKey(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

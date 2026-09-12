/**
 * Postgres schema for the Central Controller.
 *
 * Design notes:
 * - Users never touch nodes directly; access is mediated by `node_credentials`
 *   rows (one VLESS UUID + REALITY short-id per user per node).
 * - `payment_events` is the idempotency ledger for gateway webhooks.
 * - `signing_keys` supports Ed25519 key rotation for public artifacts.
 */
import { pgTable, uuid, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, bigint } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('user'), // 'user' | 'admin'
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
    /** Payment provider discriminator for the adapter layer ('placeholder' today). */
    provider: text('provider'),
    providerCustomerId: text('provider_customer_id'),
    providerSubscriptionId: text('provider_subscription_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('subscriptions_user_uq').on(t.userId), index('subscriptions_provider_customer_idx').on(t.providerCustomerId)],
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
    publicIp: text('public_ip').notNull(),
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

export const signingKeys = pgTable('signing_keys', {
  keyId: text('key_id').primaryKey(),
  publicKeyPem: text('public_key_pem').notNull(),
  /** Only the active key's private half is stored; rotation inserts a new row. */
  privateKeyPem: text('private_key_pem'),
  active: boolean('active').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  (t) => [index('usage_rollups_credential_idx').on(t.credentialId, t.windowStart)],
);

/** JWT ID set for access-token revocation lists (post-logout invalidation). */
export const revokedAccessTokens = pgTable('revoked_access_tokens', {
  jti: text('jti').primaryKey(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

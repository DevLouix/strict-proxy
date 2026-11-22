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
    /** The coupon applied when this checkout was opened, if any. */
    couponCode: text('coupon_code'),
    /** Discount taken off the catalog price, in the checkout currency. */
    discountMinor: integer('discount_minor').notNull().default(0),
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
    /**
     * Commit the node-agent image was built from, as reported by the agent.
     * Null until a build that sends it heartbeats, which is also how the
     * console tells a stale image from a node whose log POST was rejected.
     */
    agentBuild: text('agent_build'),
    /**
     * Set while the agent has drained itself for an engine restart. Expires so a
     * drain whose restart never finished cannot keep the node out of rotation;
     * an operator's drain has no expiry and is preserved by the heartbeat.
     */
    autoDrainUntil: timestamp('auto_drain_until', { withTimezone: true }),
    /**
     * Latest self-check the agent reported: is the managed engine running, and
     * did usage collection reach its stats API. Null until a node reports one,
     * so an old agent is not shown as broken.
     */
    engineHealthy: boolean('engine_healthy'),
    statsApiHealthy: boolean('stats_api_healthy'),
    engineHealthCheckedAt: timestamp('engine_health_checked_at', { withTimezone: true }),
    /** HMAC secret for internal node API calls. Issued at registration. */
    hmacSecret: text('hmac_secret').notNull(),
    /**
     * The previous secret, honored until `previous_hmac_secret_expires_at`.
     * Without a grace window, rotation would need the controller and the node
     * to switch at the same instant; this lets the operator update the node and
     * restart it without dropping it out of the fleet in between.
     */
    previousHmacSecret: text('previous_hmac_secret'),
    previousHmacSecretExpiresAt: timestamp('previous_hmac_secret_expires_at', { withTimezone: true }),
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
    /**
     * The install that owns this credential.
     *
     * Credentials used to be unique per (user, node), so two devices on one
     * account shared a single identity: revoking one revoked both, and "one
     * session per account" could not be enforced. They are now per (user, node,
     * device) so the newest install can take the session and the previous one's
     * credentials can be revoked on their own.
     */
    deviceId: text('device_id'),
    /** Bandwidth accounting for the current period (bytes), updated by nodes. */
    bytesUsed: bigint('bytes_used', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    uniqueIndex('node_credentials_user_node_device_uq').on(t.userId, t.nodeId, t.deviceId),
    uniqueIndex('node_credentials_uuid_uq').on(t.uuid),
  ],
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

/**
 * Operator action log.
 *
 * Destructive actions used to be unattributed. The actor's email is captured
 * alongside the foreign key because users can be deleted, and an audit row that
 * only pointed at a missing row would lose the name of whoever did it.
 *
 * Writes are best-effort: a failure to audit must never undo the action it
 * describes, but it is logged loudly.
 */
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    /** 'user' | 'node' | 'enrollment' | 'checkout' | 'client_release' | … */
    targetType: text('target_type'),
    targetId: text('target_id'),
    summary: text('summary').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admin_audit_log_created_idx').on(t.createdAt),
    index('admin_audit_log_actor_idx').on(t.actorId),
    index('admin_audit_log_target_idx').on(t.targetType, t.targetId),
  ],
);

/**
 * The one active proxy session per account.
 *
 * The proxy cannot close a TCP connection a client already holds, so "one
 * session per account" is enforced in two halves: this row names the winning
 * install and which session id it holds, and credential provisioning revokes
 * every other install's node credentials. The losing client also polls this
 * row, so it can shut its own tunnel down instead of sitting connected with
 * credentials the node no longer accepts.
 */
export const vpnSessions = pgTable(
  'vpn_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Client-generated install id that currently owns the session. */
    deviceId: text('device_id').notNull(),
    /** Opaque id the winning client presents; a losing client's id stops matching. */
    sessionId: text('session_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per install, not per account: the tier's seats are how many
    // installs may hold a tunnel at once. A credential cannot add a row of its
    // own, so sharing a UUID still occupies exactly one seat.
    uniqueIndex('vpn_sessions_user_device_uq').on(t.userId, t.deviceId),
    uniqueIndex('vpn_sessions_session_uq').on(t.sessionId),
    index('vpn_sessions_device_idx').on(t.deviceId),
  ],
);

/**
 * Operator-published links to sites protected by the Gatekeeper.
 *
 * The operator gates the site itself (Gatekeeper middleware, `requiredTier`),
 * then records it here so registered users can find it. `required_tier` is the
 * same minimum plan the Gatekeeper enforces; the app only uses it to explain
 * what the account can and cannot open. Access URLs are minted per request with
 * a short-lived ticket, so a link pasted into another browser never carries a
 * standing credential.
 */
export const gatedLinks = pgTable(
  'gated_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    description: text('description'),
    /** Minimum plan the protected site accepts: 'standard' | 'pro'. */
    requiredTier: text('required_tier').notNull().default('standard'),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('gated_links_url_uq').on(t.url), index('gated_links_active_idx').on(t.active)],
);

/** JWT ID set for access-token revocation lists (post-logout invalidation). */
export const revokedAccessTokens = pgTable('revoked_access_tokens', {
  jti: text('jti').primaryKey(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/**
 * Android builds published from the admin dashboard's Client apps screen.
 *
 * One row per build number; the APKs themselves live on disk and are described
 * by `client_release_artifacts`. The newest *published* row is what the app's
 * in-app updater is offered. A draft is uploaded but not served, so an operator
 * can stage a build (and check its checksum) before releasing it.
 */
export const clientReleases = pgTable(
  'client_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').notNull().default('android'),
    /** Version name shown to users, e.g. `0.2.0`. */
    version: text('version').notNull(),
    /** Android version code; clients compare it with their own build number. */
    buildNumber: integer('build_number').notNull(),
    notes: text('notes').notNull().default(''),
    /** 'draft' | 'published' | 'revoked' */
    status: text('status').notNull().default('draft'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('client_releases_platform_build_uq').on(t.platform, t.buildNumber),
    index('client_releases_status_idx').on(t.status),
  ],
);

/**
 * One APK per ABI for a release.
 *
 * Split builds are much smaller than a universal APK, so the updater asks for
 * the artifact matching the device's CPU and falls back to `universal` when the
 * operator uploaded a single APK.
 */
export const clientReleaseArtifacts = pgTable(
  'client_release_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    releaseId: uuid('release_id')
      .notNull()
      .references(() => clientReleases.id, { onDelete: 'cascade' }),
    /** `arm64-v8a` | `armeabi-v7a` | `x86_64` | `universal` */
    abi: text('abi').notNull(),
    /** Path relative to CLIENT_ANDROID_STORAGE_DIR. */
    fileName: text('file_name').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('client_release_artifacts_release_abi_uq').on(t.releaseId, t.abi)],
);

/**
 * Discount codes.
 *
 * Kept local rather than delegated to the gateway: the amount charged has to be
 * decided and recorded here, and a code must be enforceable even when the
 * provider's coupon API is unavailable. A code is either a percentage or a
 * fixed amount in one currency, can be capped and dated, and every redemption is
 * tied to a user so the same account cannot reuse it.
 */
export const coupons = pgTable(
  'coupons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Normalised, upper-case code. Unique so one code means one offer. */
    code: text('code').notNull(),
    /** 'percent' | 'amount' */
    kind: text('kind').notNull(),
    percentOff: integer('percent_off'),
    amountOffMinor: integer('amount_off_minor'),
    /** Currency the fixed amount is expressed in; null for percentage codes. */
    currency: text('currency'),
    /** null means unlimited redemptions. */
    maxRedemptions: integer('max_redemptions'),
    timesRedeemed: integer('times_redeemed').notNull().default(0),
    active: boolean('active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('coupons_code_uq').on(t.code), index('coupons_active_idx').on(t.active)],
);

/** One coupon use, unique per account so a code cannot be redeemed twice. */
export const couponRedemptions = pgTable(
  'coupon_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    couponId: uuid('coupon_id')
      .notNull()
      .references(() => coupons.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    checkoutReference: text('checkout_reference'),
    amountBeforeMinor: integer('amount_before_minor').notNull(),
    amountAfterMinor: integer('amount_after_minor').notNull(),
    currency: text('currency').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('coupon_redemptions_user_uq').on(t.couponId, t.userId),
    index('coupon_redemptions_coupon_idx').on(t.couponId),
  ],
);

/**
 * Crash reports posted by the mobile client.
 *
 * The home-screen crash was invisible to the operator because nothing left the
 * device. Reports are unauthenticated (a crash can happen before sign-in) and
 * therefore capped, truncated and deduplicated by the client-generated
 * `report_id`, so a retry after a flaky network cannot fill the table.
 */
export const clientCrashReports = pgTable(
  'client_crash_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Client-generated id, used to make delivery idempotent. */
    reportId: text('report_id'),
    platform: text('platform').notNull().default('android'),
    appVersion: text('app_version'),
    buildNumber: integer('build_number'),
    abi: text('abi'),
    device: text('device'),
    osVersion: text('os_version'),
    message: text('message').notNull(),
    stack: text('stack'),
    context: jsonb('context').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('client_crash_reports_report_uq').on(t.reportId),
    index('client_crash_reports_created_idx').on(t.createdAt),
  ],
);

/**
 * Gatekeeper site API keys issued by the Key Factory.
 *
 * Each gated website gets its own single-line secret (`sp_gk_<prefix>_<secret>`),
 * hashed with SHA-256 before storage and shown once at creation or rotation.
 * The Gatekeeper SDK exchanges this key at `GET /api/v1/gatekeeper/bootstrap`
 * to fetch the signed fleet exit-IP list and controller Ed25519 public key in
 * one round-trip — eliminating manual multi-line PEM copying and allowing
 * per-site revocation and usage tracking without sacrificing offline Ed25519
 * entitlement verification.
 */
export const gatekeeperKeys = pgTable(
  'gatekeeper_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Operator-assigned site or application name (e.g. "Partner Portal"). */
    name: text('name').notNull(),
    /** Non-secret display prefix (e.g. "sp_gk_a1b2c3d4") for identifying keys in UI/logs. */
    keyPrefix: text('key_prefix').notNull(),
    /** SHA-256 hex digest of the raw site key. Plaintext is never persisted. */
    keyHash: text('key_hash').notNull(),
    /** Registered site origin (e.g. https://portal.example.com) for open-redirect-safe pass handoff. */
    siteUrl: text('site_url'),
    /** Optional domain or operator notes. */
    note: text('note'),
    active: boolean('active').notNull().default(true),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('gatekeeper_keys_hash_uq').on(t.keyHash),
    index('gatekeeper_keys_active_idx').on(t.active),
  ],
);

/**
 * OpenPay payment gateway adapter.
 *
 * OpenPay is the provider of record: hosted checkout is opened through its
 * SDK, and entitlement changes are driven exclusively by signed webhooks it
 * delivers to `/webhooks/payments`.
 *
 * Signature scheme (Stripe-style):
 *   header: `x-openpay-signature: t=<unix-seconds>,v1=<hex>`
 *   signed: HMAC-SHA256(secret, "<t>." + rawRequestBody)   -> hex
 *
 * The header name and the timestamp tolerance are configuration, so a
 * deployment that fronts the endpoint differently can adjust without a code
 * change. Verification fails closed on anything unexpected.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { OpenPayApi, OpenPayError } from '@fiatden/openpay';
import type { PaymentEvent, PaymentEventType, SubscriptionTier } from '@strict-proxy/types';
import type { Request } from 'express';
import type { PaymentGatewayAdapter } from './payments.js';
import type { ControllerConfig } from '../env.js';

export interface OpenPaySettings {
  apiKey: string;
  baseUrl: string;
  webhookSecret: string;
  signatureHeader: string;
  timestampToleranceSeconds: number;
  platformName: string;
}

/** True when the deployment has enough config to talk to OpenPay. */
export function isOpenPayConfigured(cfg: ControllerConfig): boolean {
  return cfg.openpayApiKey.length > 0 && cfg.openpayWebhookSecret.length > 0;
}

export function openPaySettings(cfg: ControllerConfig): OpenPaySettings {
  return {
    apiKey: cfg.openpayApiKey,
    baseUrl: cfg.openpayBaseUrl,
    webhookSecret: cfg.openpayWebhookSecret,
    signatureHeader: cfg.openpaySignatureHeader.toLowerCase(),
    timestampToleranceSeconds: cfg.openpayTimestampToleranceSeconds,
    platformName: cfg.openpayPlatformName,
  };
}

/** Creates the SDK client. Throws if the deployment is not configured. */
export function createOpenPayClient(cfg: ControllerConfig): OpenPayApi {
  const settings = openPaySettings(cfg);
  if (!settings.apiKey) throw new Error('openpay_not_configured: OPENPAY_API_KEY is not set');
  return new OpenPayApi(settings.apiKey, {
    baseUrl: settings.baseUrl,
    platformName: settings.platformName,
  });
}

export function isOpenPayError(err: unknown): err is OpenPayError {
  return err instanceof OpenPayError;
}

export interface GatewayErrorShape {
  /** HTTP status to return to our caller. */
  status: number;
  /** Stable machine-readable code defined by this controller. */
  code: string;
  /** Human-readable, safe to surface. */
  message: string;
  /** The provider's own code, verbatim, for programmatic handling. */
  providerCode: string | null;
  /** Whether the caller can usefully retry as-is. */
  retryable: boolean;
}

/**
 * Picks the most informative reason from a gateway error.
 *
 * OpenPay puts the specific cause in `code` ("No configured providers
 * available for this merchant") and a generic sentence in `message` ("Checkout
 * session creation failed"), so preferring `message` would hide the only
 * actionable detail. A `code` containing whitespace is prose; one without is an
 * identifier and is kept as `providerCode` instead.
 */
export function describeOpenPayError(err: unknown): GatewayErrorShape {
  if (!isOpenPayError(err)) {
    return {
      status: 502,
      code: 'BILLING_PROVIDER_UNAVAILABLE',
      message: 'The payment provider could not be reached.',
      providerCode: null,
      retryable: true,
    };
  }

  const rawCode = typeof err.code === 'string' ? err.code.trim() : '';
  const rawMessage = typeof err.message === 'string' ? err.message.trim() : '';
  const message = rawCode && /\s/.test(rawCode) ? rawCode : rawMessage || rawCode || 'payment provider error';
  const providerCode = rawCode || null;

  // 4xx: the request (or our credentials) is the problem, so pass the status
  // through and keep the provider's own reason.
  if (err.status >= 400 && err.status < 500) {
    return {
      status: err.status,
      code: err.status === 429 ? 'BILLING_RATE_LIMITED' : 'BILLING_REJECTED',
      message,
      providerCode,
      retryable: err.status === 429,
    };
  }

  // 5xx: our service is healthy, the gateway is not.
  return {
    status: 502,
    code: 'BILLING_PROVIDER_ERROR',
    message,
    providerCode,
    retryable: true,
  };
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/** Parses `t=<unix>,v1=<hex>` (any order, extra elements ignored). */
export function parseSignatureHeader(header: string): { timestamp: string; v1: string } | null {
  let timestamp = '';
  let v1 = '';
  for (const part of header.split(',')) {
    const [key, ...rest] = part.split('=');
    const value = rest.join('=').trim();
    const k = key?.trim();
    if (k === 't') timestamp = value;
    else if (k === 'v1') v1 = value;
  }
  if (!timestamp || !v1) return null;
  return { timestamp, v1 };
}

/**
 * Verifies a Stripe-style signature over the raw body.
 *
 * Returns a discriminated result so callers can log *why* a request was
 * rejected without leaking that detail to the caller.
 */
export function verifyOpenPaySignature(params: {
  header: string | undefined;
  rawBody: Buffer | undefined;
  secret: string;
  timestampToleranceSeconds: number;
  nowSeconds?: number;
}): { ok: true } | { ok: false; reason: 'missing_header' | 'malformed' | 'stale' | 'mismatch' } {
  if (!params.header) return { ok: false, reason: 'missing_header' };
  if (!params.rawBody) return { ok: false, reason: 'missing_header' };

  const parsed = parseSignatureHeader(params.header);
  if (!parsed) return { ok: false, reason: 'malformed' };

  const signedAt = Number.parseInt(parsed.timestamp, 10);
  if (!Number.isFinite(signedAt)) return { ok: false, reason: 'malformed' };

  // Reject stale and far-future timestamps; without this an intercepted
  // webhook could be replayed indefinitely, since it is only idempotent
  // while the provider keeps resending.
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - signedAt) > params.timestampToleranceSeconds) {
    return { ok: false, reason: 'stale' };
  }

  const expected = createHmac('sha256', params.secret)
    .update(`${parsed.timestamp}.`, 'utf8')
    .update(params.rawBody)
    .digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(parsed.v1, 'hex');
  } catch {
    return { ok: false, reason: 'mismatch' };
  }
  if (provided.length !== expected.length) return { ok: false, reason: 'mismatch' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

/**
 * OpenPay event name -> our provider-agnostic event.
 *
 * `charge.failed` is deliberately NOT mapped. A failed one-time checkout means
 * the customer never received access, so there is nothing to revoke; treating
 * it as a dunning event would strip an existing paid subscription over a
 * failed *new* purchase. Recurring failures arrive as
 * `subscription.renewal_failed` / `invoice.payment_failed` and do revoke.
 */
const EVENT_MAP: Record<string, PaymentEventType> = {
  'charge.success': 'checkout.completed',
  'checkout.completed': 'checkout.completed',
  'subscription.deleted': 'subscription.deleted',
  'subscription.canceled': 'subscription.deleted',
  'subscription.cancelled': 'subscription.deleted',
  'subscription.renewal_failed': 'invoice.payment_failed',
  'invoice.payment_failed': 'invoice.payment_failed',
};

/**
 * True when the payload is part of a recurring subscription rather than a
 * one-off purchase. Used to decide whether a failed charge should dangle a
 * subscription or be ignored.
 */
function isSubscriptionContext(object: Record<string, unknown>, data: Record<string, unknown>): boolean {
  const has = (v: unknown) => typeof v === 'string' && v.length > 0 || v === true;
  return (
    has(object['subscription_id']) ||
    has(object['subscriptionId']) ||
    has(object['subscription']) ||
    has(data['subscription_id']) ||
    object['object'] === 'subscription' ||
    object['kind'] === 'subscription' ||
    object['is_recurring'] === true
  );
}

/**
 * Resolves a provider event name to our internal event type.
 *
 * `charge.failed` is resolved conditionally. A failed one-off checkout means
 * the customer never received access, so revoking there would strip an
 * unrelated, already-paid subscription. The same event *is* a dunning signal
 * when the payload shows it is part of a recurring subscription.
 */
function resolveEventType(rawType: string, object: Record<string, unknown>, data: Record<string, unknown>): PaymentEventType | null {
  const mapped = EVENT_MAP[rawType];
  if (mapped) return mapped;
  if (rawType === 'charge.failed' || rawType === 'payment.failed') {
    return isSubscriptionContext(object, data) ? 'invoice.payment_failed' : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Pulls the meaningful fields out of an OpenPay event envelope.
 * Tolerant of shape differences: the object may nest under `data`, `payload`
 * or be flat, and metadata may sit at either level.
 */
export function mapOpenPayEvent(body: unknown): PaymentEvent | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;
  const data = (root['data'] ?? root['payload'] ?? root) as Record<string, unknown>;

  const id = str(root['id']) ?? str(root['event_id']) ?? str(root['eventId']);
  const rawType = str(root['type']) ?? str(root['event']) ?? str(root['event_type']);
  if (!id || !rawType) return null;

  const object = (data['object'] ?? data) as Record<string, unknown>;
  const type = resolveEventType(rawType, object, data);
  if (!type) return null;

  const metadata = {
    ...((object['metadata'] as Record<string, unknown>) ?? {}),
    ...((root['metadata'] as Record<string, unknown>) ?? {}),
  };

  const tierRaw = str(metadata['tier']) ?? str(object['tier']);
  const periodEnd =
    str(object['current_period_end']) ??
    str(object['period_end']) ??
    str(metadata['current_period_end']) ??
    null;

  return {
    id,
    type,
    providerCustomerId:
      str(object['customer_id']) ?? str(object['customerId']) ?? str(data['customer_id']) ?? str(metadata['customer_id']),
    providerSubscriptionId:
      str(object['subscription_id']) ??
      str(object['subscriptionId']) ??
      str(data['subscription_id']) ??
      str(metadata['subscription_id']),
    userId: str(metadata['user_id']) ?? str(metadata['userId']),
    tier: tierRaw && tierRaw in { free: 1, standard: 1, pro: 1 } ? (tierRaw as SubscriptionTier) : null,
    currentPeriodEnd: periodEnd,
    raw: root,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapts OpenPay to the controller's `PaymentGatewayAdapter` contract.
 * The controller never calls the provider to decide entitlement; it only
 * consumes events this adapter has already cryptographically verified.
 */
export class OpenPayAdapter implements PaymentGatewayAdapter {
  readonly providerId = 'openpay';

  constructor(private readonly settings: OpenPaySettings) {}

  verifyWebhook(req: Request, cfg: ControllerConfig): boolean {
    void cfg;
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    return verifyOpenPaySignature({
      header: req.header(this.settings.signatureHeader),
      rawBody: raw,
      secret: this.settings.webhookSecret,
      timestampToleranceSeconds: this.settings.timestampToleranceSeconds,
    }).ok;
  }

  parseEvent(req: Request): PaymentEvent | null {
    return mapOpenPayEvent(req.body);
  }
}

/** Builds the adapter for the current config, or null when unconfigured. */
export function createOpenPayAdapter(cfg: ControllerConfig): OpenPayAdapter | null {
  if (!isOpenPayConfigured(cfg)) return null;
  return new OpenPayAdapter(openPaySettings(cfg));
}
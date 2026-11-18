/**
 * Outbound email over SMTP, configured from the admin dashboard.
 *
 * Why settings and not environment: SMTP credentials are per-deployment and
 * rotate on their own schedule, so making them a deploy-time change couples a
 * password rotation to a restart. They are stored encrypted (see
 * `services/settings.ts`) and the password is never readable over the API.
 *
 * Sending never throws into a request handler. Every caller here is a security
 * or lifecycle path — a password reset must not 500 because a mail server is
 * down, and it must not silently appear to have worked. `sendMail` therefore
 * reports what happened, and each caller decides how loudly to complain.
 */
import { createHash } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';
import { getSetting } from './settings.js';

const PREFIX = 'smtp.';

export const SETTING_HOST = `${PREFIX}host`;
export const SETTING_PORT = `${PREFIX}port`;
export const SETTING_SECURE = `${PREFIX}secure`;
export const SETTING_USER = `${PREFIX}username`;
export const SETTING_PASSWORD = `${PREFIX}password`;
export const SETTING_FROM = `${PREFIX}fromAddress`;
export const SETTING_FROM_NAME = `${PREFIX}fromName`;

export interface SmtpSettings {
  host: string;
  port: number;
  /** Implicit TLS (port 465). When false, STARTTLS is used if the server offers it. */
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

/** Whether enough is configured to attempt a send. */
export function isMailConfigured(s: SmtpSettings | null): s is SmtpSettings {
  return s !== null && s.host.length > 0 && s.fromAddress.includes('@');
}

/** Rejects settings that would fail in confusing ways later. */
export function validateSmtpSettings(input: Partial<SmtpSettings>): string[] {
  const errors: string[] = [];
  if (input.host !== undefined && input.host.trim().length === 0) errors.push('host must not be empty');
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    errors.push('port must be an integer between 1 and 65535');
  }
  if (input.fromAddress !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.fromAddress.trim())) {
    errors.push('fromAddress must be a valid email address');
  }
  // `secure` and `username` are free-form; `password` may be empty for an
  // unauthenticated relay, which is legitimate on a private network.
  return errors;
}

/**
 * Loads SMTP settings, decrypting the password.
 *
 * A secret that cannot be decrypted is logged, not swallowed silently. It
 * happens when `SETTINGS_ENCRYPTION_KEY` changes underneath a stored password,
 * and the symptom otherwise is "the password looks unset" — which sends an
 * operator hunting through mail-server logs instead of at the obvious cause.
 */
export async function loadSmtpSettings(db: Db, cfg: ControllerConfig): Promise<SmtpSettings | null> {
  const readOptional = async (key: string): Promise<string | null> => {
    try {
      return await getSetting(db, cfg, key);
    } catch (err) {
      console.error(`[controller] setting ${key} is unreadable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  const [host, port, secure, username, fromAddress, fromName] = await Promise.all([
    readOptional(SETTING_HOST),
    readOptional(SETTING_PORT),
    readOptional(SETTING_SECURE),
    readOptional(SETTING_USER),
    readOptional(SETTING_FROM),
    readOptional(SETTING_FROM_NAME),
  ]);

  // The password is the one setting whose loss must be visible.
  let password: string | null = null;
  try {
    password = await getSetting(db, cfg, SETTING_PASSWORD, { revealSecrets: true });
  } catch (err) {
    console.error(
      `[controller] the SMTP password could not be decrypted and mail will fail to authenticate: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!host?.trim() || !fromAddress?.trim()) return null;
  return {
    host: host.trim(),
    port: port ? Number.parseInt(port, 10) : 587,
    // Port 465 is implicit TLS; anything else defaults to STARTTLS. The stored
    // flag wins when explicitly set, so an operator can use implicit TLS on an
    // unusual port.
    secure: secure === null ? Number.parseInt(port ?? '587', 10) === 465 : secure === 'true',
    username: username?.trim() ?? '',
    password: password ?? '',
    fromAddress: fromAddress.trim(),
    fromName: fromName?.trim() || cfg.openpayPlatformName || 'StrictProxy',
  };
}

/** What happened to a send attempt. */
export type SendResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: 'not_configured' | 'rejected_recipient' | 'failed'; detail?: string };

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Cached transport keyed by the settings that built it.
 *
 * Nodemailer pools connections internally; rebuilding one per email would mean
 * a fresh TLS handshake for every password reset. Invalidate by bumping
 * [[generation]] when settings change.
 */
let cachedTransport: { key: string; transport: Transporter } | null = null;

function transportFor(s: SmtpSettings): Transporter {
  // Hash the password instead of hashing its length: a rotation to another
  // password of the same length would otherwise keep the old transport, and
  // every send would keep authenticating with the stale credential.
  const key = JSON.stringify([
    s.host,
    s.port,
    s.secure,
    s.username,
    createHash('sha256').update(s.password).digest('hex'),
    s.fromAddress,
  ]);
  if (cachedTransport?.key === key) return cachedTransport.transport;

  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    // Without `secure`, nodemailer upgrades opportunistically — which allows a
    // silent plaintext fallback. Require TLS unless the operator explicitly
    // turns it off for a trusted relay.
    secure: s.secure,
    requireTLS: !s.secure,
    ignoreTLS: false,
    auth: s.username ? { user: s.username, pass: s.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  cachedTransport = { key, transport };
  return transport;
}

/** Drops the cached transport; call after settings change. */
export function invalidateMailTransport(): void {
  cachedTransport = null;
}

/**
 * Checks that the saved settings can reach and authenticate with the SMTP
 * server, without sending a message.
 *
 * This is the difference between "mail is configured" (host and from address
 * are present) and "mail is connected". Nodemailer's verify reports DNS, TLS,
 * certificate and authentication failures here, with the server's own reply,
 * instead of leaving the operator to guess from a failed send.
 */
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'failed'; detail?: string };

export async function verifyMailSettings(db: Db, cfg: ControllerConfig): Promise<VerifyResult> {
  const settings = await loadSmtpSettings(db, cfg);
  if (!isMailConfigured(settings)) return { ok: false, reason: 'not_configured' };
  try {
    await transportFor(settings).verify();
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[controller] mail connection check failed: ${detail}`);
    return { ok: false, reason: 'failed', detail };
  }
}

/** Sends one message. Never throws. */
export async function sendMail(db: Db, cfg: ControllerConfig, message: MailMessage): Promise<SendResult> {
  const settings = await loadSmtpSettings(db, cfg);
  if (!isMailConfigured(settings)) return { sent: false, reason: 'not_configured' };

  try {
    const info = await transportFor(settings).sendMail({
      from: `"${settings.fromName.replace(/"/g, '')}" <${settings.fromAddress}>`,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { sent: true, messageId: String(info.messageId ?? '') };
  } catch (err) {
    // Log the reason; never include the password in an error message.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[controller] mail send to ${message.to} failed: ${detail}`);
    return { sent: false, reason: 'failed', detail };
  }
}

// ---------------------------------------------------------------------------
// Templates
//
// Plain text first: it is the part that always renders, and a password reset
// that depends on HTML being supported is a reset that fails silently.
// ---------------------------------------------------------------------------

/** The link a reset email points at. */
export function resetLink(cfg: ControllerConfig, token: string): string {
  const base = cfg.publicAppUrl.replace(/\/+$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

/** Body of a password reset email. */
export function passwordResetEmail(cfg: ControllerConfig, token: string, ttlMinutes: number): { subject: string; text: string; html: string } {
  const link = resetLink(cfg, token);
  return {
    subject: 'Reset your StrictProxy password',
    text: [
      'Someone asked to reset the password for this account.',
      '',
      `Open this link within ${ttlMinutes} minutes to choose a new password:`,
      link,
      '',
      'The link works once. If you did not ask for this, you can ignore this email —',
      'your password has not changed.',
    ].join('\n'),
    html: [
      '<p>Someone asked to reset the password for this account.</p>',
      `<p><a href="${link}">Choose a new password</a> — the link works once and expires in ${ttlMinutes} minutes.</p>`,
      '<p>If you did not ask for this, ignore this email. Your password has not changed.</p>',
    ].join('\n'),
  };
}

/** Body of a subscription lapsed notice. */
export function subscriptionLapsedEmail(opts: { tier: string; endedAt: string; renewUrl: string }): { subject: string; text: string; html: string } {
  return {
    subject: 'Your StrictProxy subscription has ended',
    text: [
      `Your ${opts.tier} subscription ended on ${opts.endedAt}.`,
      '',
      'Your servers have been switched off. Renew to pick up where you left off:',
      opts.renewUrl,
    ].join('\n'),
    html: [
      `<p>Your ${opts.tier} subscription ended on ${opts.endedAt}.</p>`,
      `<p>Your servers have been switched off. <a href="${opts.renewUrl}">Renew</a> to pick up where you left off.</p>`,
    ].join('\n'),
  };
}

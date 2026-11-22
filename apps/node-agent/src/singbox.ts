/**
 * Renders the sing-box server configuration for VLESS + REALITY from the
 * desired credential state, and persists the last-applied state so the agent
 * only triggers sing-box restarts on real changes.
 */
import { promises as fs } from 'node:fs';
import type { AgentConfig } from './config.js';

export interface Credential {
  uuid: string;
  shortId: string;
  userEmail: string;
  expiresAt: string | null;
  revoked: boolean;
}

/**
 * Whether a credential's own expiry has passed.
 *
 * `expiresAt` was carried end to end and never read, so a credential the
 * controller had expired would keep being rendered as a live user. An
 * unparseable value is treated as expired: a credential whose validity cannot
 * be established must not be handed to the engine.
 */
function credentialExpired(c: Credential, now: number): boolean {
  if (c.expiresAt === null) return false;
  const at = Date.parse(c.expiresAt);
  return Number.isNaN(at) || at <= now;
}

/** Live (non-revoked, unexpired) credentials, the desired sing-box users. */
export function liveCredentials(all: Credential[]): Array<{ uuid: string; shortId: string; email: string }> {
  const now = Date.now();
  return all
    .filter((c) => !c.revoked && !credentialExpired(c, now))
    .map((c) => ({ uuid: c.uuid, shortId: c.shortId, email: c.userEmail }))
    // Order is part of the rendered config, and the controller's sync query has
    // no ORDER BY: once usage reporting rewrites the credential rows, Postgres
    // returns them in a new heap order. That alone changed the JSON, so the
    // agent restarted sing-box about once a minute for an unchanged user set,
    // dropping every live tunnel connection. Sorting makes the render, and the
    // fingerprint derived from it, depend on the users rather than on row order.
    .sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
}

/**
 * The REALITY settings to render with, when the controller re-states them.
 *
 * The agent keeps the settings it last applied and a bootstrap response only
 * replaces them when it carries a complete identity. An empty or partial
 * response — a controller fault, a row mid-update — would otherwise render an
 * engine that rejects every client, so the settings already applied win.
 */
export function resolveRealitySettings(
  current: { privateKey: string; shortIds: string[]; serverName: string },
  incoming: { privateKey: string; shortIds: string[]; serverName: string },
): { privateKey: string; shortIds: string[]; serverName: string } {
  const usable =
    incoming.privateKey.trim() !== '' && incoming.serverName.trim() !== '' && incoming.shortIds.length > 0;
  return usable ? incoming : current;
}

/** Renders a sing-box 1.10+ server config with VLESS + REALITY inbound. */
export function renderSingBoxConfig(params: {
  cfg: AgentConfig;
  realityPrivateKey: string;
  shortIds: string[];
  serverName: string;
  users: Array<{ uuid: string; shortId: string; email: string }>;
}): object {
  const { cfg, realityPrivateKey, shortIds, serverName, users } = params;
  return {
    // The agent's LOG_LEVEL (default `info`) also sets sing-box's own level.
    // While traffic was dying behind a `connected` tunnel the node log showed
    // only failed handshakes, because a successful REALITY connection logs
    // nothing at `warn` — so "the phone never arrived" and "the phone connected
    // and the traffic died behind us" looked identical. `warn` stays the
    // fallback for a config object that predates the field.
    log: { level: cfg.logLevel ?? 'warn', timestamp: true },
    inbounds: [
      {
        type: 'vless',
        tag: 'vless-reality-in',
        listen: '::',
        listen_port: cfg.tunnelPort,
        users: users.map((u) => ({ name: u.email, uuid: u.uuid, flow: 'xtls-rprx-vision' })),
        tls: {
          enabled: true,
          server_name: serverName,
          reality: {
            enabled: true,
            handshake: { server: serverName, server_port: 443 },
            private_key: realityPrivateKey,
            short_id: shortIds,
          },
        },
      },
    ],
    experimental: {
      v2ray_api: {
        listen: cfg.statsApiListen,
        stats: {
          enabled: true,
          users: users.map((u) => u.email),
        },
      },
    },
    outbounds: [{ type: 'direct', tag: 'direct' }],
  };
}

/** True when the rendered config differs from the currently applied one. */
export async function needsApply(configPath: string, rendered: string): Promise<boolean> {
  try {
    const current = await fs.readFile(configPath, 'utf8');
    return current !== rendered;
  } catch {
    return true;
  }
}

/** Atomically writes the config file. */
export async function writeConfigAtomic(configPath: string, rendered: string): Promise<void> {
  const tmp = `${configPath}.tmp`;
  await fs.mkdir(configPath.substring(0, configPath.lastIndexOf('/')) || '.', { recursive: true });
  await fs.writeFile(tmp, rendered, 'utf8');
  await fs.rename(tmp, configPath);
}

/**
 * Replaces the config only when the candidate passes validation.
 *
 * The previous order was write-then-validate, which left a rejected config on
 * disk. The running engine kept the old one, the fingerprint was never saved,
 * and the next sync found the file already equal to the render — so it skipped
 * the retry, saved the fingerprint, and the node reported a state it was not
 * running. The invalid file then crash-looped the engine on the next container
 * start. Validating before the rename keeps the applied config (and therefore
 * the running engine) intact, and returning false leaves the fingerprint
 * unsaved so the next sync retries instead of believing it succeeded.
 */
export async function writeConfigIfValid(
  configPath: string,
  rendered: string,
  validate: (candidatePath: string) => Promise<boolean>,
): Promise<boolean> {
  const tmp = `${configPath}.next`;
  await fs.mkdir(configPath.substring(0, configPath.lastIndexOf('/')) || '.', { recursive: true });
  await fs.writeFile(tmp, rendered, 'utf8');
  let accepted = false;
  try {
    accepted = await validate(tmp);
  } catch {
    // A validator that throws is a refusal, not an acceptance.
    accepted = false;
  }
  if (!accepted) {
    await fs.rm(tmp, { force: true });
    return false;
  }
  await fs.rename(tmp, configPath);
  return true;
}

/** Last-applied credential fingerprint to detect churn without restarts. */
export async function loadAppliedFingerprint(statePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    return (JSON.parse(raw) as { fingerprint?: string }).fingerprint ?? null;
  } catch {
    return null;
  }
}

export async function saveAppliedFingerprint(statePath: string, fingerprint: string): Promise<void> {
  await fs.mkdir(statePath.substring(0, statePath.lastIndexOf('/')) || '.', { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({ fingerprint, updatedAt: new Date().toISOString() }), 'utf8');
}

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

/** Live (non-revoked) credentials, the desired sing-box users. */
export function liveCredentials(all: Credential[]): Array<{ uuid: string; shortId: string; email: string }> {
  return all
    .filter((c) => !c.revoked)
    .map((c) => ({ uuid: c.uuid, shortId: c.shortId, email: c.userEmail }));
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
    log: { level: 'warn', timestamp: true },
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

/**
 * Node Agent configuration. A fresh VPS needs only CONTROLLER_URL,
 * NODE_ENROLLMENT_TOKEN, and NODE_PUBLIC_IP; the issued node identity is
 * persisted locally after enrollment.
 */
import { existsSync, readFileSync } from 'node:fs';
import { optionalInt, optionalString, requireInt, requireString } from '@strict-proxy/types';

export interface PersistedNodeIdentity {
  nodeId: string;
  hmacSecret: string;
  region: string;
  enrolledAt: string;
}

export interface AgentConfig {
  controllerBaseUrl: string;
  nodeId: string | null;
  hmacSecret: string | null;
  enrollmentToken: string | null;
  identityPath: string;
  singBoxConfigPath: string;
  singBoxBinaryPath: string;
  singBoxRestartMode: 'systemd' | 'managed';
  statsApiListen: string;
  statsApiProtoPath: string;
  heartbeatIntervalSeconds: number;
  syncIntervalSeconds: number;
  usageIntervalSeconds: number;
  publicIp: string;
  tunnelPort: number;
  hostname: string;
  label: string | null;
  realityServerName: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function loadPersistedIdentity(path: string): PersistedNodeIdentity | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistedNodeIdentity>;
    if (typeof parsed.nodeId !== 'string' || typeof parsed.hmacSecret !== 'string') return null;
    return {
      nodeId: parsed.nodeId,
      hmacSecret: parsed.hmacSecret,
      region: typeof parsed.region === 'string' ? parsed.region : '',
      enrolledAt: typeof parsed.enrolledAt === 'string' ? parsed.enrolledAt : '',
    };
  } catch {
    return null;
  }
}

export function loadAgentConfig(): AgentConfig {
  const identityPath = optionalString('NODE_IDENTITY_PATH', '/etc/strict-proxy/node-identity.json');
  const persisted = loadPersistedIdentity(identityPath);
  return {
    controllerBaseUrl: requireString('CONTROLLER_URL', 'e.g. https://controller.example.com'),
    nodeId: optionalEnv('NODE_ID') ?? persisted?.nodeId ?? null,
    hmacSecret: optionalEnv('NODE_HMAC_SECRET') ?? persisted?.hmacSecret ?? null,
    enrollmentToken: optionalEnv('NODE_ENROLLMENT_TOKEN'),
    identityPath,
    singBoxConfigPath: optionalString('SING_BOX_CONFIG_PATH', '/etc/sing-box/config.json'),
    singBoxBinaryPath: optionalString('SING_BOX_BINARY', '/usr/local/bin/sing-box'),
    singBoxRestartMode: optionalString('SING_BOX_RESTART_MODE', 'systemd') as AgentConfig['singBoxRestartMode'],
    statsApiListen: optionalString('SING_BOX_STATS_API_LISTEN', '127.0.0.1:10085'),
    statsApiProtoPath: optionalString('SING_BOX_STATS_PROTO', '/opt/strict-proxy/node-agent/src/v2rayapi/stats.proto'),
    heartbeatIntervalSeconds: optionalInt('HEARTBEAT_INTERVAL_SECONDS', 30),
    syncIntervalSeconds: optionalInt('SYNC_INTERVAL_SECONDS', 60),
    usageIntervalSeconds: optionalInt('USAGE_INTERVAL_SECONDS', 60),
    publicIp: requireString('NODE_PUBLIC_IP', 'public IPv4 of this exit node'),
    tunnelPort: requireInt('NODE_TUNNEL_PORT', 'VLESS+REALITY listen port, e.g. 443'),
    hostname: optionalString('NODE_HOSTNAME', 'node.local'),
    label: optionalEnv('NODE_LABEL'),
    realityServerName: optionalString('NODE_REALITY_SERVER_NAME', 'www.microsoft.com'),
    logLevel: optionalString('LOG_LEVEL', 'info') as AgentConfig['logLevel'],
  };
}

export function assertAuthenticatedConfig(cfg: AgentConfig): asserts cfg is AgentConfig & { nodeId: string; hmacSecret: string } {
  if (!cfg.nodeId || !cfg.hmacSecret) throw new Error('node identity is not enrolled');
}

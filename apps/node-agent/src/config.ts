/**
 * Node Agent configuration. A fresh VPS needs only CONTROLLER_URL and
 * NODE_ENROLLMENT_TOKEN; the issued node identity is persisted locally after
 * enrollment. NODE_PUBLIC_IP is optional: when it is unset the agent detects
 * its own public address and reports it to the controller.
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
  /** Operator-pinned public IP; null means "detect it" (see `publicIpEchoUrl`). */
  publicIp: string | null;
  /** Echo service used to detect the node's own public IP; null disables detection. */
  publicIpEchoUrl: string | null;
  publicIpDetectIntervalSeconds: number;
  tunnelPort: number;
  hostname: string;
  label: string | null;
  realityServerName: string;
  /** Commit the image was built from; "dev" when running from source. */
  agentBuild: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/**
 * Resolves the IP-echo service the agent uses to learn its own public address.
 *
 * Defaults to a well-known service when unset; setting the variable to an empty
 * value, `off`, `none` or `disabled` turns detection off so the node reports
 * only its configured `NODE_PUBLIC_IP`.
 */
function resolvePublicIpEchoUrl(): string | null {
  const raw = process.env.NODE_PUBLIC_IP_ECHO_URL;
  if (raw === undefined) return 'https://api.ipify.org';
  const value = raw.trim();
  if (!value || ['off', 'none', 'disabled'].includes(value.toLowerCase())) return null;
  return value;
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
    publicIp: optionalEnv('NODE_PUBLIC_IP'),
    publicIpEchoUrl: resolvePublicIpEchoUrl(),
    publicIpDetectIntervalSeconds: optionalInt('NODE_PUBLIC_IP_DETECT_INTERVAL_SECONDS', 600),
    tunnelPort: requireInt('NODE_TUNNEL_PORT', 'VLESS+REALITY listen port, e.g. 443'),
    hostname: optionalString('NODE_HOSTNAME', 'node.local'),
    label: optionalEnv('NODE_LABEL'),
    realityServerName: optionalString('NODE_REALITY_SERVER_NAME', 'www.microsoft.com'),
    agentBuild: optionalEnv('AGENT_BUILD') ?? 'dev',
    logLevel: optionalString('LOG_LEVEL', 'info') as AgentConfig['logLevel'],
  };
}

export function assertAuthenticatedConfig(cfg: AgentConfig): asserts cfg is AgentConfig & { nodeId: string; hmacSecret: string } {
  if (!cfg.nodeId || !cfg.hmacSecret) throw new Error('node identity is not enrolled');
}

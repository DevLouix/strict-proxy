/**
 * Node Agent configuration, validated at startup.
 */
import { optionalInt, optionalString, requireInt, requireString } from '@strict-proxy/types';

export interface AgentConfig {
  /** Controller base URL, e.g. https://controller.example.com */
  controllerBaseUrl: string;
  /** This node's id (UUID) as registered with the controller. */
  nodeId: string;
  /**
   * HMAC secret for internal API calls. In production this is delivered by
   * your secrets manager; the bootstrap flow provisions it on registration.
   */
  hmacSecret: string;
  /** Local sing-box config output path (rendered by the agent). */
  singBoxConfigPath: string;
  /** Local sing-box binary path (agent validates presence). */
  singBoxBinaryPath: string;
  heartbeatIntervalSeconds: number;
  syncIntervalSeconds: number;
  /** What this node reports as its public IP (must match registration). */
  publicIp: string;
  tunnelPort: number;
  region: string;
  hostname: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadAgentConfig(): AgentConfig {
  return {
    controllerBaseUrl: requireString('CONTROLLER_URL', 'e.g. https://controller.example.com'),
    nodeId: requireString('NODE_ID', 'UUID returned by node registration'),
    hmacSecret: requireString('NODE_HMAC_SECRET', 'secret issued at registration; use a secrets manager'),
    singBoxConfigPath: optionalString('SING_BOX_CONFIG_PATH', '/etc/sing-box/config.json'),
    singBoxBinaryPath: optionalString('SING_BOX_BINARY', '/usr/local/bin/sing-box'),
    heartbeatIntervalSeconds: optionalInt('HEARTBEAT_INTERVAL_SECONDS', 30),
    syncIntervalSeconds: optionalInt('SYNC_INTERVAL_SECONDS', 60),
    publicIp: requireString('NODE_PUBLIC_IP', 'public IPv4 of this exit node'),
    tunnelPort: requireInt('NODE_TUNNEL_PORT', 'VLESS+REALITY listen port, e.g. 443'),
    region: requireString('NODE_REGION', 'e.g. eu-central'),
    hostname: requireString('NODE_HOSTNAME', 'globally unique node hostname'),
    logLevel: optionalString('LOG_LEVEL', 'info') as AgentConfig['logLevel'],
  };
}

/**
 * Controller client for enrollment and HMAC-authenticated node operations.
 */
import { buildHmacHeaders } from '@strict-proxy/types';
import type { AgentConfig } from './config.js';

export class ControllerClient {
  constructor(private readonly cfg: AgentConfig) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.cfg.nodeId || !this.cfg.hmacSecret) throw new Error('node identity is not enrolled');
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      ...buildHmacHeaders({ nodeId: this.cfg.nodeId, secret: this.cfg.hmacSecret, method, path, body: bodyStr }),
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.cfg.controllerBaseUrl}${path}`, { method, headers, body: body === undefined ? undefined : bodyStr });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      if (res.status === 401) {
        throw new Error(
          `controller ${method} ${path} -> 401: ${detail}. ` +
            'If this node\'s secret was rotated, set NODE_HMAC_SECRET to the new value and restart the agent.',
        );
      }
      throw new Error(`controller ${method} ${path} -> ${res.status}: ${detail}`);
    }
    return (await res.json()) as T;
  }

  async enroll(): Promise<{ nodeId: string; hmacSecret: string; region: string }> {
    if (!this.cfg.enrollmentToken) throw new Error('NODE_ENROLLMENT_TOKEN is required for first boot');
    const res = await fetch(`${this.cfg.controllerBaseUrl}/api/v1/nodes/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: this.cfg.enrollmentToken,
        hostname: this.cfg.hostname,
        label: this.cfg.label,
        // Omitted when unknown so the controller can derive it from the
        // enrolling connection instead of being sent a placeholder.
        ...(this.cfg.publicIp ? { publicIp: this.cfg.publicIp } : {}),
        tunnelPort: this.cfg.tunnelPort,
        realityServerName: this.cfg.realityServerName,
        realityShortIds: Array.from({ length: 8 }, () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')),
        engineVersion: 'unknown',
      }),
    });
    if (!res.ok) throw new Error(`node enrollment failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as { nodeId: string; hmacSecret: string; region: string };
  }

  bootstrap(): Promise<{ nodeId: string; hostname: string; region: string; publicIp: string; tunnelPort: number; reality: { privateKey: string; shortIds: string[]; serverName: string } }> {
    return this.request('GET', '/internal/v1/node/bootstrap');
  }

  heartbeat(report: {
    cpuPercent: number;
    memoryPercent: number;
    bandwidthBytes: number;
    uplinkRttMs: number;
    uptimeSeconds: number;
    engineVersion: string;
    /** Commit this agent image was built from; \"dev\" outside a published image. */
    agentBuild: string;
    /** The port the engine is configured to listen on for clients. */
    tunnelPort: number;
    /** The agent's own view of its engine; the controller shows it in the fleet. */
    engineHealthy?: boolean;
    statsApiHealthy?: boolean;
    observedPublicIp?: string;
  }): Promise<{ ok: boolean; controllerTime: string; sendLogs?: boolean }> {
    return this.request('POST', '/internal/v1/node/heartbeat', report);
  }

  /** Buffered log lines, posted only when a heartbeat response asked for them. */
  postLogs(logs: Array<{ at: string; level: string; msg: string }>): Promise<{ ok: boolean; delivered: boolean }> {
    return this.request('POST', '/internal/v1/node/logs', { logs });
  }

  sync(): Promise<{ credentials: Array<{ uuid: string; shortId: string; userEmail: string; expiresAt: string | null; revoked: boolean }>; controllerTime: string }> {
    return this.request('GET', '/internal/v1/node/sync');
  }

  reportUsage(usage: Array<{ uuid: string; bytesUp: number; bytesDown: number; windowStart: string; windowEnd: string }>): Promise<{ ok: boolean; applied: number }> {
    return this.request('POST', '/internal/v1/node/usage', { usage });
  }
}

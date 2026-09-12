/**
 * Signed HTTP client for the controller's internal (HMAC) API.
 */
import { buildHmacHeaders } from '@strict-proxy/types';
import type { AgentConfig } from './config.js';

export class ControllerClient {
  constructor(private readonly cfg: AgentConfig) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      ...buildHmacHeaders({
        nodeId: this.cfg.nodeId,
        secret: this.cfg.hmacSecret,
        method,
        path,
        body: bodyStr,
      }),
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await fetch(`${this.cfg.controllerBaseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : bodyStr,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`controller ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
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
  }): Promise<{ ok: boolean; controllerTime: string }> {
    return this.request('POST', '/internal/v1/node/heartbeat', report);
  }

  sync(): Promise<{ credentials: Array<{ uuid: string; shortId: string; userEmail: string; expiresAt: string | null; revoked: boolean }>; controllerTime: string }> {
    return this.request('GET', '/internal/v1/node/sync');
  }

  reportUsage(usage: Array<{ uuid: string; bytesUp: number; bytesDown: number; windowStart: string; windowEnd: string }>): Promise<{ ok: boolean; applied: number }> {
    return this.request('POST', '/internal/v1/node/usage', { usage });
  }
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type { AgentConfig } from './config.js';
import type { ControllerClient } from './controller-client.js';
import type { Credential } from './singbox.js';

interface Stat {
  name?: string;
  value?: number | string;
}

interface QueryResponse {
  stat?: Stat[];
}

interface StatsClient {
  QueryStats(request: { patterns: string[]; reset: boolean }, callback: (error: Error | null, response: QueryResponse) => void): void;
  close(): void;
}

function statValue(stats: Stat[], suffix: string): number {
  const row = stats.find((stat) => typeof stat.name === 'string' && stat.name.endsWith(suffix));
  return Math.max(0, Number(row?.value ?? 0));
}

/**
 * Reads per-user counters from sing-box V2Ray API. The API must be bound to
 * loopback and exposed only through the node agent's local process boundary.
 */
export async function collectUserUsage(cfg: AgentConfig, client: ControllerClient, credentials: Credential[]): Promise<void> {
  if (credentials.length === 0) return;
  const protoPath = path.resolve(cfg.statsApiProtoPath);
  await fs.access(protoPath);
  const packageDefinition = await protoLoader.load(protoPath, { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as { experimental: { v2rayapi: { StatsService: { new (address: string, credentials: grpc.ChannelCredentials): StatsClient } } } };
  const StatsService = loaded.experimental.v2rayapi.StatsService;
  const stats = new StatsService(cfg.statsApiListen, grpc.credentials.createInsecure());
  try {
    const usage = await Promise.all(credentials.filter((credential) => !credential.revoked).map(async (credential) => {
      const prefix = `user>>>${credential.userEmail}>>>traffic>>>`;
      const result = await new Promise<QueryResponse>((resolve, reject) => {
        stats.QueryStats({ patterns: [`${prefix}uplink`, `${prefix}downlink`], reset: true }, (error, response) => error ? reject(error) : resolve(response));
      });
      return {
        uuid: credential.uuid,
        bytesUp: statValue(result.stat ?? [], 'uplink'),
        bytesDown: statValue(result.stat ?? [], 'downlink'),
        windowStart: new Date(Date.now() - cfg.usageIntervalSeconds * 1000).toISOString(),
        windowEnd: new Date().toISOString(),
      };
    }));
    await client.reportUsage(usage);
  } finally {
    stats.close();
  }
}

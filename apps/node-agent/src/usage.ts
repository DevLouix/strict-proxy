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

interface StatsServiceConstructor {
  new (address: string, credentials: grpc.ChannelCredentials): StatsClient;
  service: Record<string, grpc.MethodDefinition<unknown, unknown>>;
}

/** gRPC status for "the endpoint is not listening yet". */
const STATUS_UNAVAILABLE = 14;
/** gRPC status for "this server does not expose that service or method". */
const STATUS_UNIMPLEMENTED = 12;

/**
 * sing-box 1.14 registers the stats service under the v2ray-compatible name,
 * even though the proto package is `experimental.v2rayapi` (see
 * experimental/v2rayapi/stats.go, which rewrites the service descriptor).
 * Older builds used the proto package name, so try the current name first and
 * fall back rather than shipping a client that can only talk to one of them.
 */
const STATS_SERVICE_NAMES = ['v2ray.core.app.stats.command.StatsService', 'experimental.v2rayapi.StatsService'];
const READINESS_PATTERN = 'strict-proxy-ready';

function grpcStatus(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

/**
 * Retries `query` while the engine's stats API is still coming up. sing-box
 * binds the API a moment after it starts, so the first collection after a
 * restart (or a recreated container) sees ECONNREFUSED - gRPC UNAVAILABLE -
 * even in a build that has V2Ray API support.
 */
export async function withStatsApiReady<T>(query: () => Promise<T>, attempts = 10, delayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await query();
    } catch (err) {
      lastError = err;
      if (grpcStatus(err) !== STATUS_UNAVAILABLE) throw err;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function statValue(stats: Stat[], suffix: string): number {
  const row = stats.find((stat) => typeof stat.name === 'string' && stat.name.endsWith(suffix));
  return Math.max(0, Number(row?.value ?? 0));
}

function queryStats(stats: StatsClient, patterns: string[], reset: boolean): Promise<QueryResponse> {
  return new Promise<QueryResponse>((resolve, reject) => {
    stats.QueryStats({ patterns, reset }, (error, response) => (error ? reject(error) : resolve(response)));
  });
}

/**
 * Rebuilds the generated client under a different gRPC service name. The
 * method path is kept verbatim (grpc-js camel-cases the method key, so the
 * path's last segment - `QueryStats` - is the only reliable source).
 */
function withServiceName(Base: StatsServiceConstructor, serviceName: string): StatsServiceConstructor {
  const definition: Record<string, grpc.MethodDefinition<unknown, unknown>> = {};
  for (const [method, def] of Object.entries(Base.service)) {
    definition[method] = { ...def, path: `/${serviceName}/${def.path.split('/').pop() ?? method}` };
  }
  return grpc.makeGenericClientConstructor(definition, 'StatsService') as unknown as StatsServiceConstructor;
}

/**
 * Opens a stats client against whichever service name the running engine
 * registered. The readiness probe changes no counters, so trying both names is
 * free; any other error (port refused, auth, config) is reported immediately.
 */
async function connectStatsApi(cfg: AgentConfig, Base: StatsServiceConstructor): Promise<StatsClient> {
  let unimplemented: unknown;
  for (const serviceName of STATS_SERVICE_NAMES) {
    const client = new (withServiceName(Base, serviceName))(cfg.statsApiListen, grpc.credentials.createInsecure());
    try {
      await withStatsApiReady(() => queryStats(client, [READINESS_PATTERN], false));
      return client;
    } catch (err) {
      client.close();
      if (grpcStatus(err) !== STATUS_UNIMPLEMENTED) throw err;
      unimplemented = err;
    }
  }
  throw unimplemented instanceof Error
    ? unimplemented
    : new Error(`no V2Ray stats service on ${cfg.statsApiListen}`);
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
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as { experimental: { v2rayapi: { StatsService: StatsServiceConstructor } } };
  const stats = await connectStatsApi(cfg, loaded.experimental.v2rayapi.StatsService);
  try {
    const usage = await Promise.all(credentials.filter((credential) => !credential.revoked).map(async (credential) => {
      const prefix = `user>>>${credential.userEmail}>>>traffic>>>`;
      const result = await withStatsApiReady(() => queryStats(stats, [`${prefix}uplink`, `${prefix}downlink`], true));
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

/**
 * Deployment self-check for a node.
 *
 * A node can heartbeat perfectly while the thing clients need — a listening
 * VLESS+REALITY port — is held by nginx, Caddy, Traefik or a second agent.
 * That produced a fleet full of "online" nodes whose tunnels carried nothing.
 * This check runs before the agent starts and reports what a person can fix.
 */
import { accessSync, constants } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAgentConfig } from './config.js';

/** TCP state for a socket in LISTEN, in /proc/net/tcp and tcp6. */
const TCP_LISTEN = '0A';

/** Ports in the LISTEN state across the given /proc/net/tcp tables. */
export function listeningPorts(...tables: string[]): Set<number> {
  const ports = new Set<number>();
  for (const table of tables) {
    for (const line of table.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 4 || columns[3] !== TCP_LISTEN) continue;
      const local = columns[1] ?? '';
      const encoded = local.slice(local.lastIndexOf(':') + 1);
      if (!/^[0-9a-fA-F]+$/.test(encoded)) continue;
      const port = Number.parseInt(encoded, 16);
      if (Number.isInteger(port) && port > 0) ports.add(port);
    }
  }
  return ports;
}

export interface NodeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The checks that decide whether this node can serve clients at all.
 *
 * A listening tunnel port is deliberately not an error here: with
 * `SING_BOX_RESTART_MODE=systemd` the engine is already up when the agent
 * starts. The install script refuses to continue when a foreign process holds
 * the port, which is the point where it can still be fixed.
 */
export function checkNodeAccess(
  cfg: { singBoxBinaryPath: string; tunnelPort: number },
  canExecute: (file: string) => boolean = (file) => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): NodeCheck[] {
  const executable = canExecute(cfg.singBoxBinaryPath);
  const validPort = Number.isInteger(cfg.tunnelPort) && cfg.tunnelPort > 0 && cfg.tunnelPort <= 65535;
  return [
    {
      name: 'sing-box binary',
      ok: executable,
      detail: executable
        ? `${cfg.singBoxBinaryPath} is executable`
        : `${cfg.singBoxBinaryPath} is missing or not executable; install sing-box or set SING_BOX_BINARY`,
    },
    {
      name: 'tunnel port',
      ok: validPort,
      detail: validPort
        ? `clients connect to port ${cfg.tunnelPort}`
        : `NODE_TUNNEL_PORT must be between 1 and 65535, got ${cfg.tunnelPort}`,
    },
  ];
}

/** Human-readable report; the CLI prints one line per check. */
export function formatChecks(checks: NodeCheck[]): string {
  return checks
    .map((check) => `${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`)
    .join('\n');
}

async function readTables(): Promise<string[]> {
  return Promise.all(
    ['/proc/net/tcp', '/proc/net/tcp6'].map((file) => readFile(file, 'utf8').catch(() => '')),
  );
}

async function main(): Promise<void> {
  const cfg = loadAgentConfig();
  const checks = checkNodeAccess(cfg);
  const listening = listeningPorts(...(await readTables()));
  console.log(formatChecks(checks));
  console.log(
    listening.has(cfg.tunnelPort)
      ? `ok   port ${cfg.tunnelPort} is listening`
      : `note port ${cfg.tunnelPort} is not listening yet; the agent starts the engine and the heartbeat reports whether it binds`,
  );
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

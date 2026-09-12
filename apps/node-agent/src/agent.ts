/**
 * Strict-proxy Node Agent.
 *
 * Responsibilities:
 *  - Bootstrap from the controller (REALITY keys, ports).
 *  - Heartbeat loop: CPU/RAM/bandwidth/RTT reports.
 *  - Credential sync loop: converge local sing-box users to controller state.
 *  - Usage reporting loop: per-credential bandwidth (aggregated placeholders
 *    until sing-box stats are wired per deployment).
 *  - sing-box supervision: validate, write config, restart on change.
 *
 * All controller calls are HMAC-signed; secrets come from the environment.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import si from 'systeminformation';
import { loadAgentConfig, type AgentConfig } from './config.js';
import { ControllerClient } from './controller-client.js';
import {
  renderSingBoxConfig,
  liveCredentials,
  needsApply,
  writeConfigAtomic,
  loadAppliedFingerprint,
  saveAppliedFingerprint,
  type Credential,
} from './singbox.js';

const execFileP = promisify(execFile);

function log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, ...rest: unknown[]): void {
  if (level === 'debug' && process.env.LOG_LEVEL !== 'debug') return;
  console.log(`[${new Date().toISOString()}][${level}] ${msg}`, ...rest);
}

/** Shells out to sing-box for config validation before applying. */
async function validateSingBoxConfig(binary: string, configPath: string): Promise<boolean> {
  try {
    await execFileP(binary, ['check', '-c', configPath], { timeout: 10_000 });
    return true;
  } catch (err) {
    log('error', 'sing-box config validation failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Restarts the systemd unit managing sing-box. */
async function restartSingBox(): Promise<void> {
  await execFileP('systemctl', ['restart', 'sing-box.service'], { timeout: 30_000 });
}

function fingerprint(credentials: Credential[]): string {
  return createHash('sha256').update(JSON.stringify(liveCredentials(credentials))).digest('hex');
}

class Agent {
  private readonly client: ControllerClient;
  private realityPrivateKey = '';
  private realityShortIds: string[] = [];
  private realityServerName = '';
  private running = true;

  constructor(private readonly cfg: AgentConfig) {
    this.client = new ControllerClient(cfg);
  }

  async bootstrap(): Promise<void> {
    const boot = await this.client.bootstrap();
    if (boot.publicIp !== this.cfg.publicIp) {
      log('warn', `public IP mismatch: controller=${boot.publicIp} local=${this.cfg.publicIp}; trusting controller`);
    }
    this.realityPrivateKey = boot.reality.privateKey;
    this.realityShortIds = boot.reality.shortIds;
    this.realityServerName = boot.reality.serverName;
    log('info', `bootstrapped node ${boot.nodeId} (${boot.region})`);
  }

  async heartbeatOnce(): Promise<void> {
    const [cpu, mem, net, osUptime] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      si.time(),
    ]);
    const cpuPercent = cpu.currentLoad ?? 0;
    const memoryPercent = mem.active / Math.max(1, mem.total) * 100;
    const bandwidthBytes = net.reduce((acc, n) => acc + (n.rx_sec ?? 0) + (n.tx_sec ?? 0), 0);
    const uplinkRttMs = await this.measureUplinkRtt();
    const uptimeSeconds = Math.floor(osUptime.uptime);
    await this.client.heartbeat({
      cpuPercent: Number(cpuPercent.toFixed(2)),
      memoryPercent: Number(memoryPercent.toFixed(2)),
      bandwidthBytes: Math.round(bandwidthBytes),
      uplinkRttMs,
      uptimeSeconds,
      engineVersion: await this.singBoxVersion(),
    });
    log('debug', 'heartbeat sent');
  }

  /** TCP connect timing to the controller as a cheap uplink probe. */
  private async measureUplinkRtt(): Promise<number> {
    const start = Date.now();
    try {
      const url = new URL(this.cfg.controllerBaseUrl);
      await fetch(`${url.origin}/healthz`, { signal: AbortSignal.timeout(5_000) });
      return Date.now() - start;
    } catch {
      return -1;
    }
  }

  private versionCache: { value: string; at: number } | null = null;

  private async singBoxVersion(): Promise<string> {
    if (this.versionCache && Date.now() - this.versionCache.at < 3600_000) return this.versionCache.value;
    try {
      const { stdout } = await execFileP(this.cfg.singBoxBinaryPath, ['version'], { timeout: 5_000 });
      const value = stdout.split('\n')[0]?.trim() ?? 'unknown';
      this.versionCache = { value, at: Date.now() };
      return value;
    } catch {
      return 'unknown';
    }
  }

  async syncOnce(): Promise<void> {
    const state = await this.client.sync();
    const creds: Credential[] = state.credentials;
    const fp = fingerprint(creds);
    const applied = await loadAppliedFingerprint(`${this.cfg.singBoxConfigPath}.state`);
    if (applied === fp) {
      log('debug', 'credentials unchanged; skipping apply');
      return;
    }

    const rendered = JSON.stringify(
      renderSingBoxConfig({
        cfg: this.cfg,
        realityPrivateKey: this.realityPrivateKey,
        shortIds: this.realityShortIds,
        serverName: this.realityServerName,
        users: liveCredentials(creds),
      }),
      null,
      2,
    );

    if (await needsApply(this.cfg.singBoxConfigPath, rendered)) {
      await writeConfigAtomic(this.cfg.singBoxConfigPath, rendered);
      if (!(await validateSingBoxConfig(this.cfg.singBoxBinaryPath, this.cfg.singBoxConfigPath))) {
        log('error', 'rendered config invalid; NOT restarting sing-box');
        return;
      }
      await restartSingBox();
      log('info', `applied ${liveCredentials(creds).length} credential(s), sing-box restarted`);
    }
    await saveAppliedFingerprint(`${this.cfg.singBoxConfigPath}.state`, fp);
  }

  async reportUsageOnce(): Promise<void> {
    // NOTE: per-credential byte counters require sing-box's stats/Clash API
    // (experimental.enable) — wire your collector here per deployment.
    // The endpoint exists and is HMAC-protected; sending an empty window is a no-op.
    await this.client.reportUsage([]);
  }

  start(): void {
    const hb = setInterval(() => {
      this.heartbeatOnce().catch((err) => log('warn', 'heartbeat failed:', err instanceof Error ? err.message : err));
    }, this.cfg.heartbeatIntervalSeconds * 1000);
    hb.unref();

    const sync = setInterval(() => {
      this.syncOnce().catch((err) => log('warn', 'sync failed:', err instanceof Error ? err.message : err));
    }, this.cfg.syncIntervalSeconds * 1000);
    sync.unref();

    const usage = setInterval(() => {
      this.reportUsageOnce().catch((err) => log('debug', 'usage report failed:', err instanceof Error ? err.message : err));
    }, 60_000);
    usage.unref();

    process.on('SIGINT', () => this.stop(hb, sync, usage));
    process.on('SIGTERM', () => this.stop(hb, sync, usage));
    log('info', 'agent started');
  }

  private stop(...timers: NodeJS.Timeout[]): void {
    if (!this.running) return;
    this.running = false;
    timers.forEach((t) => clearInterval(t));
    log('info', 'agent stopped');
    process.exit(0);
  }
}

async function main(): Promise<void> {
  const cfg = loadAgentConfig();
  const agent = new Agent(cfg);

  // Bootstrap with bounded retries; the controller may come up after nodes.
  let booted = false;
  for (let attempt = 1; attempt <= 10 && !booted; attempt++) {
    try {
      await agent.bootstrap();
      booted = true;
    } catch (err) {
      log('warn', `bootstrap attempt ${attempt}/10 failed:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  if (!booted) {
    log('error', 'bootstrap failed after 10 attempts; exiting');
    process.exit(1);
  }

  await agent.syncOnce().catch((err) => log('warn', 'initial sync failed:', err instanceof Error ? err.message : err));
  agent.start();
}

main().catch((err) => {
  log('error', 'fatal:', err);
  process.exit(1);
});

/**
 * Strict-proxy Node Agent.
 *
 * First boot: enroll with a one-time token, persist the issued identity, then
 * bootstrap REALITY settings. Steady state: heartbeat, credential sync,
 * sing-box config convergence, and per-user usage reporting.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import si from 'systeminformation';
import { assertAuthenticatedConfig, loadAgentConfig, type AgentConfig, type PersistedNodeIdentity } from './config.js';
import { ControllerClient } from './controller-client.js';
import { collectUserUsage } from './usage.js';
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

async function validateSingBoxConfig(binary: string, configPath: string): Promise<boolean> {
  try {
    await execFileP(binary, ['check', '-c', configPath], { timeout: 10_000 });
    return true;
  } catch (err) {
    log('error', 'sing-box config validation failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

async function restartSingBox(cfg: AgentConfig, managedProcess: { current: ChildProcess | null }): Promise<void> {
  if (cfg.singBoxRestartMode === 'managed') {
    managedProcess.current?.kill('SIGTERM');
    managedProcess.current = spawn(cfg.singBoxBinaryPath, ['run', '-c', cfg.singBoxConfigPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    managedProcess.current.stdout?.on('data', (chunk: Buffer) => log('debug', `[sing-box] ${chunk.toString().trim()}`));
    managedProcess.current.stderr?.on('data', (chunk: Buffer) => log('warn', `[sing-box] ${chunk.toString().trim()}`));
    managedProcess.current.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') log('error', `managed sing-box exited (${code ?? signal ?? 'unknown'})`);
    });
    return;
  }
  await execFileP('systemctl', ['restart', 'sing-box.service'], { timeout: 30_000 });
}

function fingerprint(credentials: Credential[]): string {
  return createHash('sha256').update(JSON.stringify(liveCredentials(credentials))).digest('hex');
}

async function persistIdentity(path: string, identity: PersistedNodeIdentity): Promise<void> {
  await fs.mkdir(path.substring(0, path.lastIndexOf('/')) || '.', { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(identity, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, path);
  await fs.chmod(path, 0o600);
}

class Agent {
  private readonly client: ControllerClient;
  private readonly managedSingBox: { current: ChildProcess | null } = { current: null };
  private realityPrivateKey = '';
  private realityShortIds: string[] = [];
  private realityServerName = '';
  private credentials: Credential[] = [];
  private running = true;

  constructor(private readonly cfg: AgentConfig) {
    this.client = new ControllerClient(cfg);
  }

  async enrollIfNeeded(): Promise<void> {
    if (this.cfg.nodeId && this.cfg.hmacSecret) return;
    const enrolled = await this.client.enroll();
    await persistIdentity(this.cfg.identityPath, {
      nodeId: enrolled.nodeId,
      hmacSecret: enrolled.hmacSecret,
      region: enrolled.region,
      enrolledAt: new Date().toISOString(),
    });
    this.cfg.nodeId = enrolled.nodeId;
    this.cfg.hmacSecret = enrolled.hmacSecret;
    log('info', `enrolled node ${enrolled.nodeId} in ${enrolled.region}; identity saved to ${this.cfg.identityPath}`);
  }

  async bootstrap(): Promise<void> {
    assertAuthenticatedConfig(this.cfg);
    const boot = await this.client.bootstrap();
    if (boot.publicIp !== this.cfg.publicIp) log('warn', `public IP mismatch: controller=${boot.publicIp} local=${this.cfg.publicIp}; trusting controller`);
    this.realityPrivateKey = boot.reality.privateKey;
    this.realityShortIds = boot.reality.shortIds;
    this.realityServerName = boot.reality.serverName;
    log('info', `bootstrapped node ${boot.nodeId} (${boot.region})`);
  }

  async heartbeatOnce(): Promise<void> {
    const [cpu, mem, net, osUptime] = await Promise.all([si.currentLoad(), si.mem(), si.networkStats(), si.time()]);
    const bandwidthBytes = net.reduce((acc, n) => acc + (n.rx_sec ?? 0) + (n.tx_sec ?? 0), 0);
    await this.client.heartbeat({
      cpuPercent: Number((cpu.currentLoad ?? 0).toFixed(2)),
      memoryPercent: Number((mem.active / Math.max(1, mem.total) * 100).toFixed(2)),
      bandwidthBytes: Math.round(bandwidthBytes),
      uplinkRttMs: await this.measureUplinkRtt(),
      uptimeSeconds: Math.floor(osUptime.uptime),
      engineVersion: await this.singBoxVersion(),
    });
    log('debug', 'heartbeat sent');
  }

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
    this.credentials = state.credentials;
    const fp = fingerprint(this.credentials);
    const applied = await loadAppliedFingerprint(`${this.cfg.singBoxConfigPath}.state`);
    if (applied === fp) return;

    const rendered = JSON.stringify(renderSingBoxConfig({
      cfg: this.cfg,
      realityPrivateKey: this.realityPrivateKey,
      shortIds: this.realityShortIds,
      serverName: this.realityServerName,
      users: liveCredentials(this.credentials),
    }), null, 2);

    if (await needsApply(this.cfg.singBoxConfigPath, rendered)) {
      await writeConfigAtomic(this.cfg.singBoxConfigPath, rendered);
      if (!(await validateSingBoxConfig(this.cfg.singBoxBinaryPath, this.cfg.singBoxConfigPath))) return;
      await restartSingBox(this.cfg, this.managedSingBox);
      log('info', `applied ${liveCredentials(this.credentials).length} credential(s), sing-box restarted`);
    }
    await saveAppliedFingerprint(`${this.cfg.singBoxConfigPath}.state`, fp);
  }

  async reportUsageOnce(): Promise<void> {
    try {
      await collectUserUsage(this.cfg, this.client, this.credentials);
    } catch (err) {
      log('warn', 'usage collection failed; verify sing-box was built with V2Ray API support:', err instanceof Error ? err.message : err);
    }
  }

  start(): void {
    const hb = setInterval(() => void this.heartbeatOnce().catch((err) => log('warn', 'heartbeat failed:', err)), this.cfg.heartbeatIntervalSeconds * 1000);
    const sync = setInterval(() => void this.syncOnce().catch((err) => log('warn', 'sync failed:', err)), this.cfg.syncIntervalSeconds * 1000);
    const usage = setInterval(() => void this.reportUsageOnce(), this.cfg.usageIntervalSeconds * 1000);
    hb.unref(); sync.unref(); usage.unref();
    const stop = () => {
      if (!this.running) return;
      this.running = false;
      clearInterval(hb); clearInterval(sync); clearInterval(usage);
      this.managedSingBox.current?.kill('SIGTERM');
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    log('info', 'agent started');
  }
}

async function main(): Promise<void> {
  const cfg = loadAgentConfig();
  const agent = new Agent(cfg);
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await agent.enrollIfNeeded();
      await agent.bootstrap();
      break;
    } catch (err) {
      if (attempt === 10) throw err;
      log('warn', `bootstrap/enrollment attempt ${attempt}/10 failed:`, err instanceof Error ? err.message : err);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  await agent.syncOnce();
  await agent.heartbeatOnce();
  await agent.reportUsageOnce();
  agent.start();
}

main().catch((err) => {
  log('error', 'fatal:', err);
  process.exit(1);
});

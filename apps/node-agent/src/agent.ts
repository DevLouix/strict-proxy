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
import { detectPublicIp } from './public-ip.js';
import { collectUserUsage } from './usage.js';
import { listeningPorts } from './preflight.js';
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

/** Touched on every tick; the container healthcheck compares its mtime. */
const HEALTH_PATH = process.env.AGENT_HEALTH_PATH?.trim() || '/tmp/agent-healthy';

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
  /** True once the timers are installed, i.e. an exit is not a clean shutdown. */
  private started = false;
  /** Last self-check results, reported to the controller for the fleet view. */
  private engineHealthy: boolean | null = null;
  private statsApiHealthy: boolean | null = null;
  /** Most recent detection of this node's own public address. */
  private detectedPublicIp: string | null = null;
  private publicIpCheckedAt = 0;

  constructor(private readonly cfg: AgentConfig) {
    this.client = new ControllerClient(cfg);
  }

  /**
   * The address to advertise, re-detected at most once per configured interval.
   * Falls back to the configured `NODE_PUBLIC_IP` when detection is off or
   * unreachable, which is what makes a provider re-addressing transparent.
   */
  private async resolvePublicIp(force = false): Promise<string | null> {
    const fresh = this.publicIpCheckedAt !== 0 && Date.now() - this.publicIpCheckedAt < this.cfg.publicIpDetectIntervalSeconds * 1000;
    if (!force && fresh) return this.detectedPublicIp;
    const detected = await detectPublicIp(this.cfg);
    this.detectedPublicIp = detected;
    this.publicIpCheckedAt = Date.now();
    return detected;
  }

  async enrollIfNeeded(): Promise<void> {
    if (this.cfg.nodeId && this.cfg.hmacSecret) return;
    // Detect before enrolling so the controller records the real address even
    // when the operator did not pin one.
    this.cfg.publicIp = await this.resolvePublicIp(true);
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
    const advertised = this.cfg.publicIp ?? (await this.resolvePublicIp(true));
    if (advertised && boot.publicIp !== advertised) {
      log('warn', `public IP mismatch: controller=${boot.publicIp} local=${advertised}; the next heartbeat will reconcile it`);
    }
    this.realityPrivateKey = boot.reality.privateKey;
    this.realityShortIds = boot.reality.shortIds;
    this.realityServerName = boot.reality.serverName;
    log('info', `bootstrapped node ${boot.nodeId} (${boot.region})`);
  }

  async heartbeatOnce(): Promise<void> {
    const [cpu, mem, net, osUptime] = await Promise.all([si.currentLoad(), si.mem(), si.networkStats(), si.time()]);
    const bandwidthBytes = net.reduce((acc, n) => acc + (n.rx_sec ?? 0) + (n.tx_sec ?? 0), 0);
    const observedPublicIp = await this.resolvePublicIp();
    const engine = this.managedSingBox.current;
    const running = this.cfg.singBoxRestartMode !== 'managed' || Boolean(engine && engine.exitCode === null && !engine.killed);
    // A live process is not enough: the engine can be up while another service
    // holds the tunnel port, which leaves every client connecting into a wall.
    const listening = await this.tunnelPortListening();
    this.engineHealthy = running && listening;
    if (running && !listening) {
      log(
        'warn',
        `the engine is running but port ${this.cfg.tunnelPort} is not listening; clients cannot connect. ` +
          'A web server (nginx/Caddy/Traefik) or another VPN may hold the port; free it or change NODE_TUNNEL_PORT.',
      );
    }
    await this.client.heartbeat({
      cpuPercent: Number((cpu.currentLoad ?? 0).toFixed(2)),
      memoryPercent: Number((mem.active / Math.max(1, mem.total) * 100).toFixed(2)),
      bandwidthBytes: Math.round(bandwidthBytes),
      uplinkRttMs: await this.measureUplinkRtt(),
      uptimeSeconds: Math.floor(osUptime.uptime),
      engineVersion: await this.singBoxVersion(),
      // Sent on every heartbeat so the controller follows a node whose tunnel
      // port changed (the installer picks a free one), rather than handing
      // clients the port it enrolled with forever.
      tunnelPort: this.cfg.tunnelPort,
      engineHealthy: this.engineHealthy,
      ...(this.statsApiHealthy === null ? {} : { statsApiHealthy: this.statsApiHealthy }),
      ...(observedPublicIp ? { observedPublicIp } : {}),
    });
    log('debug', 'heartbeat sent');
  }

  private async tunnelPortListening(): Promise<boolean> {
    try {
      const tables = await Promise.all(
        ['/proc/net/tcp', '/proc/net/tcp6'].map((file) => fs.readFile(file, 'utf8').catch(() => '')),
      );
      return listeningPorts(...tables).has(this.cfg.tunnelPort);
    } catch {
      return false;
    }
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

    const rendered = JSON.stringify(renderSingBoxConfig({
      cfg: this.cfg,
      realityPrivateKey: this.realityPrivateKey,
      shortIds: this.realityShortIds,
      serverName: this.realityServerName,
      users: liveCredentials(this.credentials),
    }), null, 2);

    const configChanged = await needsApply(this.cfg.singBoxConfigPath, rendered);
    if (applied !== fp || configChanged) {
      if (configChanged) {
        await writeConfigAtomic(this.cfg.singBoxConfigPath, rendered);
        if (!(await validateSingBoxConfig(this.cfg.singBoxBinaryPath, this.cfg.singBoxConfigPath))) return;
        await restartSingBox(this.cfg, this.managedSingBox);
        log('info', `applied ${liveCredentials(this.credentials).length} credential(s), sing-box restarted`);
      }
      await saveAppliedFingerprint(`${this.cfg.singBoxConfigPath}.state`, fp);
    }
    await this.ensureEngine();
  }

  /**
   * Starts the managed engine when this process has no live child. An applied
   * fingerprint says the config on disk is current; it says nothing about the
   * engine, which does not survive a container recreate.
   */
  private async ensureEngine(): Promise<void> {
    if (this.cfg.singBoxRestartMode !== 'managed') return;
    const child = this.managedSingBox.current;
    if (child && child.exitCode === null && !child.killed) return;
    log('info', 'managed sing-box has no live process; starting it');
    await restartSingBox(this.cfg, this.managedSingBox);
  }

  /** Records that the loop is turning, for the container healthcheck. */
  private async markHealthy(): Promise<void> {
    try {
      await fs.writeFile(HEALTH_PATH, new Date().toISOString(), 'utf8');
    } catch (err) {
      log('debug', 'could not write the health file:', err instanceof Error ? err.message : err);
    }
  }

  /** One line describing what the agent can see, logged at startup. */
  async logSelfCheck(): Promise<void> {
    const child = this.managedSingBox.current;
    const engine =
      this.cfg.singBoxRestartMode === 'managed'
        ? child && child.exitCode === null
          ? `managed, pid ${child.pid ?? 'unknown'}`
          : 'managed, no live process'
        : 'systemd';
    log(
      'info',
      `self-check: sing-box ${await this.singBoxVersion()} (${engine}); stats api ${this.cfg.statsApiListen}; ` +
        `${liveCredentials(this.credentials).length} live user(s); config ${this.cfg.singBoxConfigPath}`,
    );
  }

  async reportUsageOnce(): Promise<void> {
    try {
      await collectUserUsage(this.cfg, this.client, this.credentials);
      this.statsApiHealthy = true;
    } catch (err) {
      this.statsApiHealthy = false;
      log(
        'warn',
        `usage collection failed (stats api ${this.cfg.statsApiListen}): ${err instanceof Error ? err.message : err}. ` +
          'The engine has to be running and built with V2Ray API support.',
      );
    }
  }

  start(): void {
    void this.markHealthy();
    // These timers must stay referenced: the agent has no server, so unref'd
    // timers let Node exit as soon as startup finishes. The container then
    // restarts (with Docker's backoff), the engine never stays up, and every
    // cycle fails usage collection against a closed stats port.
    const hb = setInterval(() => {
      void this.heartbeatOnce()
        .catch((err) => log('warn', 'heartbeat failed:', err instanceof Error ? err.message : err))
        .finally(() => void this.markHealthy());
    }, this.cfg.heartbeatIntervalSeconds * 1000);
    const sync = setInterval(
      () => void this.syncOnce().catch((err) => log('warn', 'sync failed:', err instanceof Error ? err.message : err)),
      this.cfg.syncIntervalSeconds * 1000,
    );
    // Supervised separately from sync so an unreachable controller cannot stop
    // the agent from restarting a dead engine.
    const engine = setInterval(
      () => void this.ensureEngine().catch((err) => log('warn', 'engine start failed:', err instanceof Error ? err.message : err)),
      this.cfg.syncIntervalSeconds * 1000,
    );
    const usage = setInterval(() => void this.reportUsageOnce(), this.cfg.usageIntervalSeconds * 1000);
    const stop = () => {
      if (!this.running) return;
      this.running = false;
      this.started = false;
      clearInterval(hb); clearInterval(sync); clearInterval(engine); clearInterval(usage);
      this.managedSingBox.current?.kill('SIGTERM');
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('exit', (code) => {
      if (this.started) {
        log('warn', `agent exiting (code ${code}) while the loop was running; it must stay alive to heartbeats, sync and report usage`);
      }
    });
    this.started = true;
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
  await agent.logSelfCheck();
  agent.start();
}

main().catch((err) => {
  log('error', 'fatal:', err);
  process.exit(1);
});

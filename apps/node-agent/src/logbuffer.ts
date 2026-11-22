/**
 * The admin log buffer.
 *
 * Kept out of `agent.ts` so retention and the payload budget can be tested
 * without starting an agent. Both exist because of the same failure: the engine
 * logs every refused handshake from the internet's scanners, and while eviction
 * was decided by line count, a burst pushed the operator's own lines — and the
 * client's REALITY rejection they clicked Logs to find — out within seconds.
 */

export type LogLine = { at: string; level: string; msg: string };

/**
 * A client address the engine refused, pinned independently of the transcript.
 *
 * Keyed by host rather than by `host:port`: a client that retries gets a new
 * source port every time, so keying by the full endpoint would list one phone
 * ten times and hide the other nine addresses to an operator looking for it.
 */
export type RefusedPeer = {
  /** Most recent `host:port` seen, or just the host when the engine omitted a port. */
  endpoint: string;
  host: string;
  at: string;
  /** Refusals seen from this host inside the retained window. */
  attempts: number;
};

/**
 * Engine output lives for two minutes, whatever the volume.
 *
 * Evicting by age is what makes a burst harmless: a burst adds lines at the
 * same instant, so it cannot age out anything. The hard cap stays as the memory
 * bound for a node that is scanned hard enough to outrun any window.
 */
const DEFAULT_ENGINE_RETENTION_MS = 120_000;
const DEFAULT_ENGINE_LIMIT = 400;

export class EngineLogRing {
  private entries: Array<{ atMs: number; line: LogLine }> = [];

  constructor(
    private readonly retentionMs = DEFAULT_ENGINE_RETENTION_MS,
    private readonly limit = DEFAULT_ENGINE_LIMIT,
  ) {}

  push(line: LogLine, now = Date.now()): void {
    this.entries.push({ atMs: now, line });
    this.prune(now);
  }

  /** Recent lines, after dropping anything past the retention window. */
  tail(now = Date.now()): LogLine[] {
    this.prune(now);
    return this.entries.map((entry) => entry.line);
  }

  private prune(now: number): void {
    const cutoff = now - this.retentionMs;
    const firstAlive = this.entries.findIndex((entry) => entry.atMs >= cutoff);
    if (firstAlive === -1) this.entries = [];
    else if (firstAlive > 0) this.entries.splice(0, firstAlive);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }
}

/**
 * How many lines each source may contribute to one request.
 *
 * A single global cap re-introduced the eviction the ring was fixed to remove:
 * a flood of engine lines at the tail of the list pushed out the agent's own
 * `applied N credential(s)` and `could not post log lines` lines even though
 * they were still buffered. A budget per source keeps each one visible.
 */
export const ADMIN_LOG_BUDGET = { recent: 200, engine: 180, tail: 120 } as const;

export function composeAdminLines(sources: {
  /** The agent's own lines, already capped as they are written. */
  recent: LogLine[];
  /** Live snapshot of the tunnel; always included, it explains a dead node. */
  snapshot: LogLine[];
  /** Managed engine stderr. */
  engine: LogLine[];
  /** The engine's journal when it is not this process's child. */
  tail: LogLine[];
}): LogLine[] {
  return [
    ...sources.recent.slice(-ADMIN_LOG_BUDGET.recent),
    ...sources.snapshot,
    ...sources.engine.slice(-ADMIN_LOG_BUDGET.engine),
    ...sources.tail.slice(-ADMIN_LOG_BUDGET.tail),
  ];
}

/**
 * sing-box reports the peer on the line that names the failure
 * (`process connection from 1.2.3.4:5678: reality: processed invalid
 * connection`). A split format that logs the address and the refusal on two
 * lines cannot be paired here, so those addresses are not pinned — the full
 * transcript above still carries both lines.
 */
const PEER_RE = /\bfrom (\[[0-9a-fA-F:]+\]|\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?/;

/** Failure words wide enough for REALITY, VLESS and handshake rejections. */
const REFUSAL_RE = /invalid|refus|reject|denied|unauthori[sz]ed|unknown (?:user|uuid|client)|handshake fail/i;

/** sing-box colours its level in the line; the colour is noise in a list. */
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/**
 * The refused endpoints an operator is looking for, newest first.
 *
 * Derived from every engine line the node still holds rather than from the
 * transcript that gets sent, so the pinned list is not bounded by the payload
 * budget: a burst can shorten the transcript but not this list.
 */
export function recentRefusedPeers(
  engine: LogLine[],
  tail: LogLine[] = [],
  limit = 10,
): RefusedPeer[] {
  const byHost = new Map<string, RefusedPeer>();
  for (const line of [...engine, ...tail]) {
    const msg = line.msg.replace(ANSI_RE, '');
    if (!REFUSAL_RE.test(msg)) continue;
    const match = PEER_RE.exec(msg);
    if (!match) continue;
    const host = match[1];
    if (!host) continue;
    const port = match[2] ?? null;
    const endpoint = port ? `${host}:${port}` : host;
    const seen = byHost.get(host);
    if (seen) {
      seen.attempts += 1;
      seen.endpoint = endpoint;
      seen.at = line.at;
    } else {
      byHost.set(host, { endpoint, host, at: line.at, attempts: 1 });
    }
  }
  // Same-instant lines keep the order they arrived in, so a retry's newest port
  // is the one shown when the engine wrote several refusals in one second.
  return [...byHost.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

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

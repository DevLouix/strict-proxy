/**
 * Strict environment variable access with validation. No silent fallbacks.
 */
export class EnvError extends Error {
  constructor(name: string, hint: string) {
    super(`Missing or invalid env var "${name}". ${hint}`);
    this.name = 'EnvError';
  }
}

/** Reads a required string env var; throws if missing/empty. */
export function requireString(name: string, hint = ''): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') throw new EnvError(name, hint);
  return v.trim();
}

/** Reads an optional string env var with a default. */
export function optionalString(name: string, defaultValue: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? defaultValue : v.trim();
}

/** Reads a required integer env var. */
export function requireInt(name: string, hint = ''): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') throw new EnvError(name, hint);
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new EnvError(name, 'Must be an integer.');
  return n;
}

/** Reads an optional integer env var with a default. */
export function optionalInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return defaultValue;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new EnvError(name, 'Must be an integer.');
  return n;
}

/** Reads a required boolean env var ("true"/"false"). */
export function requireBool(name: string, hint = ''): boolean {
  const v = process.env[name];
  if (v === undefined) throw new EnvError(name, hint);
  return v.trim().toLowerCase() === 'true';
}

/** Reads an optional boolean env var with a default. */
export function optionalBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return defaultValue;
  return v.trim().toLowerCase() === 'true';
}

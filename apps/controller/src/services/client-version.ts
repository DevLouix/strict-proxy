/**
 * The lowest client build an operator will let onto the network.
 *
 * Enforcement lives at the point credentials are handed out: an app that is too
 * old gets no tunnel config, so it cannot carry traffic however it is launched.
 * That is deliberate — checking only at sign-in would leave an already signed-in
 * install working until its token happened to expire.
 *
 * The value is a build number, not a semantic version: the APK version code is
 * what Android and the in-app updater already compare, and it is monotonic
 * across releases. `null` means the gate is off (the default, and the behaviour
 * of every deployment that never opens the setting).
 */
import { getSetting, deleteSetting, setSetting } from './settings.js';
import type { Db } from '../db/client.js';
import type { ControllerConfig } from '../env.js';

export const SETTING_MIN_CLIENT_BUILD = 'client.minBuild';

/** Header the app sends with every request: its `APP_BUILD_NUMBER`. */
export const CLIENT_BUILD_HEADER = 'x-client-build';

/**
 * Reads a build number from a header value.
 *
 * A missing, empty or non-numeric header is `null` — not zero — so callers
 * cannot accidentally treat "this build sends nothing" as a very old build and
 * allow it through a `>= 0` comparison.
 */
export function parseClientBuild(raw: string | null | undefined): number | null {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Whether a build may use the network.
 *
 * With a minimum set, a client that reports no build is refused: every APK that
 * predates this check is exactly the population the setting exists to block.
 */
export function clientMeetsMinimum(build: number | null, minimum: number | null): boolean {
  if (minimum === null) return true;
  return build !== null && build >= minimum;
}

/** The operator's minimum, or null when the gate is disabled. */
export async function minimumClientBuild(db: Db, cfg: ControllerConfig): Promise<number | null> {
  try {
    return parseClientBuild(await getSetting(db, cfg, SETTING_MIN_CLIENT_BUILD));
  } catch {
    // A settings read failure must not lock every user out of the network.
    return null;
  }
}

/** Sets the minimum, or removes it when [minimum] is null/0. */
export async function setMinimumClientBuild(
  db: Db,
  cfg: ControllerConfig,
  minimum: number | null,
  updatedBy?: string,
): Promise<void> {
  if (minimum === null || minimum === 0) {
    await deleteSetting(db, SETTING_MIN_CLIENT_BUILD);
    return;
  }
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new Error('minimum client build must be a positive integer (the APK build number)');
  }
  await setSetting(db, cfg, { key: SETTING_MIN_CLIENT_BUILD, value: String(minimum) }, updatedBy);
}

/** The 426 body the app turns into an update prompt. */
export function clientUpdateRequiredBody(minimum: number, current: number | null = null) {
  return {
    error: `This version of StrictProxy can no longer connect. Update to build ${minimum} or newer.`,
    code: 'CLIENT_UPDATE_REQUIRED',
    minimumBuild: minimum,
    ...(current === null ? {} : { currentBuild: current }),
  };
}

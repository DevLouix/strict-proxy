/**
 * Client release catalog: the builds the admin dashboard publishes and the
 * in-app updater downloads.
 *
 * Two sources feed one answer. Rows in `client_releases` are builds uploaded
 * from the dashboard; the `CLIENT_ANDROID_*` environment variables are the
 * bootstrap path for a deployment that predates the dashboard (and for tests).
 * Database rows win, so an operator can take over without deleting the env
 * values, and the environment is only consulted when nothing is published.
 *
 * The APK bytes live on disk, outside Postgres: an APK is a build artifact, not
 * application state, and a 300 MB row would make every backup unusable. Only the
 * relative file name, size and SHA-256 are stored.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clientReleaseArtifacts, clientReleases } from '../db/schema.js';

export const CLIENT_PLATFORM = 'android';

/** ABIs a release can carry, plus the single-APK fallback. */
export const CLIENT_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'universal'] as const;
export type ClientAbi = (typeof CLIENT_ABIS)[number];

export function isClientAbi(value: string): value is ClientAbi {
  return (CLIENT_ABIS as readonly string[]).includes(value);
}

export type ClientReleaseStatus = 'draft' | 'published' | 'revoked';

export interface ClientArtifact {
  abi: string;
  /** Path relative to the storage directory (database) or absolute (env). */
  fileName: string;
  sizeBytes: number;
  sha256: string;
  /** Resolved on this controller. Never sent to clients. */
  filePath: string;
}

export interface ClientRelease {
  id: string | null;
  version: string;
  buildNumber: number;
  notes: string;
  status: ClientReleaseStatus;
  source: 'database' | 'environment';
  createdAt: Date | null;
  publishedAt: Date | null;
  artifacts: ClientArtifact[];
}

/** Configuration needed to locate the published APK. */
export interface ClientReleaseConfig {
  clientAndroidVersion: string;
  clientAndroidBuildNumber: number;
  clientAndroidApkPath: string;
  clientAndroidNotes: string;
  clientAndroidStorageDir?: string;
}

/** Absolute directory holding dashboard-uploaded APKs. */
export function storageDir(cfg: ClientReleaseConfig): string {
  return path.resolve(cfg.clientAndroidStorageDir ?? 'var/client-releases');
}

/**
 * Whether the filesystem refused the upload, as opposed to the request being
 * wrong. These are the failures an operator can fix: a release volume Docker
 * created root-owned while the controller runs as another user, a read-only
 * mount, or a full disk. Everything else keeps the generic internal error.
 */
export function isStorageWriteError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOSPC';
}

/**
 * The release published by environment variables, if it is complete and its
 * file is present. Never throws: a half-configured deployment simply offers no
 * update.
 */
export function environmentRelease(cfg: ClientReleaseConfig): ClientRelease | null {
  if (cfg.clientAndroidVersion.trim() === '' || cfg.clientAndroidBuildNumber <= 0) return null;
  if (cfg.clientAndroidApkPath.trim() === '') return null;
  const filePath = path.resolve(cfg.clientAndroidApkPath);
  if (!existsSync(filePath)) return null;

  return {
    id: null,
    version: cfg.clientAndroidVersion,
    buildNumber: cfg.clientAndroidBuildNumber,
    notes: cfg.clientAndroidNotes,
    status: 'published',
    source: 'environment',
    createdAt: null,
    publishedAt: null,
    artifacts: [
      {
        abi: 'universal',
        fileName: path.basename(filePath),
        sizeBytes: statSync(filePath).size,
        sha256: '',
        filePath,
      },
    ],
  };
}

function toArtifacts(
  cfg: ClientReleaseConfig,
  rows: Array<{
    abi: string;
    fileName: string;
    sizeBytes: number;
    sha256: string;
  }>,
): ClientArtifact[] {
  const root = storageDir(cfg);
  return rows.map((row) => ({ ...row, filePath: path.resolve(root, row.fileName) }));
}

/** Every release, newest build first. */
export async function listReleases(db: Db, cfg: ClientReleaseConfig): Promise<ClientRelease[]> {
  const releases = await db.select().from(clientReleases).orderBy(desc(clientReleases.buildNumber));
  if (releases.length === 0) return [];

  const artifacts = await db.select().from(clientReleaseArtifacts);
  const byRelease = new Map<string, typeof artifacts>();
  for (const artifact of artifacts) {
    const list = byRelease.get(artifact.releaseId) ?? [];
    list.push(artifact);
    byRelease.set(artifact.releaseId, list);
  }

  return releases.map((release) => ({
    id: release.id,
    version: release.version,
    buildNumber: release.buildNumber,
    notes: release.notes,
    status: release.status as ClientReleaseStatus,
    source: 'database' as const,
    createdAt: release.createdAt,
    publishedAt: release.publishedAt,
    artifacts: toArtifacts(cfg, byRelease.get(release.id) ?? []),
  }));
}

/**
 * The build clients are offered: the highest published build, or the
 * environment-configured one when the database has no published row.
 */
export async function activeRelease(db: Db, cfg: ClientReleaseConfig): Promise<ClientRelease | null> {
  const [row] = await db
    .select()
    .from(clientReleases)
    .where(and(eq(clientReleases.platform, CLIENT_PLATFORM), eq(clientReleases.status, 'published')))
    .orderBy(desc(clientReleases.buildNumber))
    .limit(1);

  if (!row) return environmentRelease(cfg);

  const artifacts = await db
    .select()
    .from(clientReleaseArtifacts)
    .where(eq(clientReleaseArtifacts.releaseId, row.id));

  return {
    id: row.id,
    version: row.version,
    buildNumber: row.buildNumber,
    notes: row.notes,
    status: row.status as ClientReleaseStatus,
    source: 'database',
    createdAt: row.createdAt,
    publishedAt: row.publishedAt,
    artifacts: toArtifacts(cfg, artifacts),
  };
}

/**
 * Picks the APK a device should download.
 *
 * Exact ABI match first; then a universal APK; then the only artifact when the
 * release has exactly one. Returns null when the device's ABI was not built,
 * which is a real answer — downloading a foreign ABI would install an app that
 * cannot load its engine.
 */
export function selectArtifact(release: ClientRelease, requestedAbi: string | null): ClientArtifact | null {
  if (requestedAbi) {
    const exact = release.artifacts.find((artifact) => artifact.abi === requestedAbi);
    if (exact) return exact;
  }
  const universal = release.artifacts.find((artifact) => artifact.abi === 'universal');
  if (universal) return universal;
  return release.artifacts.length === 1 ? release.artifacts[0] ?? null : null;
}

export interface PublicRelease {
  version: string;
  buildNumber: number;
  sizeBytes: number;
  notes: string;
  url: string;
  artifacts: Array<{ abi: string; sizeBytes: number; sha256: string; url: string }>;
}

/** Wire shape served to the app. No file paths, no internal ids. */
export function publicRelease(release: ClientRelease): PublicRelease {
  const artifacts = release.artifacts.map((artifact) => ({
    abi: artifact.abi,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    url: `/api/v1/app/android/download?abi=${encodeURIComponent(artifact.abi)}`,
  }));
  return {
    version: release.version,
    buildNumber: release.buildNumber,
    // The largest artifact: a client that has not resolved its ABI yet shows a
    // conservative estimate rather than an understated one.
    sizeBytes: artifacts.reduce((max, artifact) => Math.max(max, artifact.sizeBytes), 0),
    notes: release.notes,
    url: '/api/v1/app/android/download',
    artifacts,
  };
}

export interface UpsertArtifactInput {
  buildNumber: number;
  version: string;
  notes: string;
  abi: ClientAbi;
  bytes: Buffer;
  createdBy?: string | null;
}

/**
 * Stores one APK and registers it against its build.
 *
 * The release row is created as a draft on first upload, so a build cannot
 * become visible just because a file finished uploading; publishing is a
 * separate, explicit action in the dashboard.
 */
export async function upsertArtifact(
  db: Db,
  cfg: ClientReleaseConfig,
  input: UpsertArtifactInput,
): Promise<ClientRelease> {
  const root = storageDir(cfg);
  const dir = path.join(root, String(input.buildNumber));
  await mkdir(dir, { recursive: true });

  const fileName = path.join(String(input.buildNumber), `${input.abi}.apk`);
  const filePath = path.join(root, fileName);
  await writeFile(filePath, input.bytes);
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');

  const [release] = await db
    .insert(clientReleases)
    .values({
      platform: CLIENT_PLATFORM,
      version: input.version,
      buildNumber: input.buildNumber,
      notes: input.notes,
      status: 'draft',
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [clientReleases.platform, clientReleases.buildNumber],
      set: { version: input.version, notes: input.notes },
    })
    .returning();
  if (!release) throw new Error('failed to store the client release row');

  await db
    .insert(clientReleaseArtifacts)
    .values({
      releaseId: release.id,
      abi: input.abi,
      fileName,
      sizeBytes: input.bytes.length,
      sha256,
    })
    .onConflictDoUpdate({
      target: [clientReleaseArtifacts.releaseId, clientReleaseArtifacts.abi],
      set: { fileName, sizeBytes: input.bytes.length, sha256 },
    });

  // Every artifact of the build, not one arbitrary row: the upload response
  // reports the stored hash for the ABI just written, so a single-row read
  // returned null for the second ABI of a split build and the release pipeline
  // treated a successful upload as broken.
  const stored = await db
    .select()
    .from(clientReleaseArtifacts)
    .where(eq(clientReleaseArtifacts.releaseId, release.id));

  return {
    id: release.id,
    version: release.version,
    buildNumber: release.buildNumber,
    notes: release.notes,
    status: release.status as ClientReleaseStatus,
    source: 'database',
    createdAt: release.createdAt,
    publishedAt: release.publishedAt,
    artifacts: toArtifacts(cfg, stored),
  };
}

/** Changes what clients are offered. Publishing stamps the time it went live. */
export async function setReleaseStatus(
  db: Db,
  buildNumber: number,
  status: ClientReleaseStatus,
): Promise<boolean> {
  const [updated] = await db
    .update(clientReleases)
    .set({ status, publishedAt: status === 'published' ? new Date() : null })
    .where(and(eq(clientReleases.platform, CLIENT_PLATFORM), eq(clientReleases.buildNumber, buildNumber)))
    .returning({ id: clientReleases.id });
  return Boolean(updated);
}

/** Removes a build, its artifact rows, and the APK files on disk. */
export async function deleteRelease(db: Db, cfg: ClientReleaseConfig, buildNumber: number): Promise<boolean> {
  const [deleted] = await db
    .delete(clientReleases)
    .where(and(eq(clientReleases.platform, CLIENT_PLATFORM), eq(clientReleases.buildNumber, buildNumber)))
    .returning({ id: clientReleases.id });
  if (!deleted) return false;
  await rm(path.join(storageDir(cfg), String(buildNumber)), { recursive: true, force: true });
  return true;
}

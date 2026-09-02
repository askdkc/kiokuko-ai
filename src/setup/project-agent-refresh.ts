import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { isProxy } from 'node:util/types';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError, type ErrorCode } from '../errors.js';
import { validateRepositoryBindingIdentity } from '../repository/identity-value.js';
import { useRepository, type UseOptions } from '../commands/use.js';

export const MAX_SETUP_PROJECT_LOCATIONS = 10_000;
const MAX_STORED_ROOT_BYTES = 4_096;

export interface RegisteredProjectLocation {
  repositoryId: string;
  workspace: string;
  repositoryRoot: string;
}

export type ProjectAgentRefreshResult = RegisteredProjectLocation & (
  | {
      status: 'created' | 'updated' | 'unchanged';
      agentFile: string;
      bindingAction: 'created' | 'updated' | 'unchanged' | 'planned';
    }
  | {
      status: 'skipped';
      agentFile: null;
      reason: 'missing_root' | 'unsafe_root';
    }
  | {
      status: 'failed';
      agentFile: null;
      reason: 'inaccessible_root' | 'use_rejected';
      errorCode: ErrorCode | 'FILESYSTEM_ERROR';
    }
);

interface ProjectLocationInput {
  repositoryId: unknown;
  workspace: unknown;
  repositoryRoot: unknown;
}

interface StoredProjectLocationRow extends ProjectLocationInput, Record<string, unknown> {}

export interface RefreshRegisteredProjectOptions {
  databasePath: string;
  migrationsDirectory?: string;
  dryRun?: boolean;
}

export interface RefreshRegisteredProjectDependencies {
  useRepository?: typeof useRepository;
  lstat?: typeof lstat;
}

export interface ListRegisteredProjectOptions {
  allowUnavailableRegistry?: boolean;
}

function storedProjectLocation(row: ProjectLocationInput): RegisteredProjectLocation {
  if (typeof row.repositoryId !== 'string' || typeof row.workspace !== 'string') {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored project identity is invalid');
  }
  try {
    validateRepositoryBindingIdentity(row.repositoryId, row.workspace);
  } catch {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored project identity is invalid');
  }
  if (typeof row.repositoryRoot !== 'string'
    || row.repositoryRoot.length === 0
    || row.repositoryRoot.includes('\0')
    || Buffer.byteLength(row.repositoryRoot, 'utf8') > MAX_STORED_ROOT_BYTES
    || !path.isAbsolute(row.repositoryRoot)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored project location is invalid');
  }
  return {
    repositoryId: row.repositoryId,
    workspace: row.workspace,
    repositoryRoot: row.repositoryRoot,
  };
}

/** Read one bounded, validated snapshot of project locations persisted by Kiokuko. */
export function listRegisteredProjectLocations(
  database: SqliteDatabase,
  options: ListRegisteredProjectOptions = {},
): RegisteredProjectLocation[] {
  const availableTables = new Set(database.prepare(`
    SELECT name
      FROM sqlite_schema
     WHERE type = 'table'
       AND name IN ('repositories', 'repository_locations')
     ORDER BY name
  `).all<{ name: string }>().map((row) => row.name));
  if (!availableTables.has('repositories') || !availableTables.has('repository_locations')) {
    if (options.allowUnavailableRegistry === true) return [];
    throw new KiokukoError('INTEGRITY_ERROR', 'Kiokuko project registry tables are unavailable');
  }
  const rows = database.prepare(`
    SELECT r.repository_id AS repositoryId,
           r.workspace AS workspace,
           l.canonical_root AS repositoryRoot
      FROM repository_locations AS l
      JOIN repositories AS r ON r.repository_id = l.repository_id
     ORDER BY l.canonical_root ASC, r.repository_id ASC
     LIMIT ?
  `).all<StoredProjectLocationRow>(MAX_SETUP_PROJECT_LOCATIONS + 1);
  if (rows.length > MAX_SETUP_PROJECT_LOCATIONS) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored project location count exceeds the setup refresh limit');
  }
  return rows.map(storedProjectLocation);
}

function errorCode(error: unknown): string | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null || isProxy(error)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

async function refreshRegisteredProject(
  location: RegisteredProjectLocation,
  options: RefreshRegisteredProjectOptions,
  dependencies: Required<RefreshRegisteredProjectDependencies>,
): Promise<ProjectAgentRefreshResult> {
  let root;
  try {
    root = await dependencies.lstat(location.repositoryRoot, { bigint: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ...location, status: 'skipped', agentFile: null, reason: 'missing_root' };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ...location,
        status: 'failed',
        agentFile: null,
        reason: 'inaccessible_root',
        errorCode: 'FILESYSTEM_ERROR',
      };
    }
    throw error;
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    return { ...location, status: 'skipped', agentFile: null, reason: 'unsafe_root' };
  }

  const useOptions: UseOptions = {
    root: location.repositoryRoot,
    repositoryId: location.repositoryId,
    workspace: location.workspace,
    allowDirectory: true,
    databasePath: options.databasePath,
    dryRun: options.dryRun === true,
    ensureNewBindingIgnored: true,
    ...(options.migrationsDirectory === undefined
      ? {}
      : { migrationsDirectory: options.migrationsDirectory }),
  };
  try {
    const result = await dependencies.useRepository(useOptions);
    if (result.agentFile === null || result.agentFileAction === 'skipped') {
      throw new KiokukoError('INTEGRITY_ERROR', 'Registered project refresh unexpectedly skipped its agent file');
    }
    return {
      ...location,
      status: result.agentFileAction,
      agentFile: result.agentFile,
      bindingAction: result.bindingAction,
    };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ...location, status: 'skipped', agentFile: null, reason: 'missing_root' };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ...location,
        status: 'failed',
        agentFile: null,
        reason: 'inaccessible_root',
        errorCode: 'FILESYSTEM_ERROR',
      };
    }
    if (error instanceof KiokukoError) {
      return {
        ...location,
        status: 'failed',
        agentFile: null,
        reason: 'use_rejected',
        errorCode: error.code,
      };
    }
    throw error;
  }
}

/** Apply the existing `kiokuko-ai use` file contract to each registered live project. */
export async function refreshRegisteredProjectAgentFiles(
  locations: readonly RegisteredProjectLocation[],
  options: RefreshRegisteredProjectOptions,
  dependencyOverrides: RefreshRegisteredProjectDependencies = {},
): Promise<ProjectAgentRefreshResult[]> {
  if (!Array.isArray(locations) || locations.length > MAX_SETUP_PROJECT_LOCATIONS) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Registered project refresh input exceeds its location limit');
  }
  const dependencies: Required<RefreshRegisteredProjectDependencies> = {
    useRepository: dependencyOverrides.useRepository ?? useRepository,
    lstat: dependencyOverrides.lstat ?? lstat,
  };
  const results: ProjectAgentRefreshResult[] = [];
  for (const location of locations) {
    results.push(await refreshRegisteredProject(storedProjectLocation(location), options, dependencies));
  }
  return results;
}

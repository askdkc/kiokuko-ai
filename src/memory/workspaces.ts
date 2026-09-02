import { createHash } from 'node:crypto';
import path from 'node:path';
import { readProjectConfig } from '../config/project-config.js';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { registerRepositoryAndLocation } from '../repository/binding.js';
import { detectRepositoryRoot, type RootSource } from '../repository/detect-root.js';
import { readGitOrigin } from '../repository/git-origin.js';
import { createRepositoryIdentity } from '../repository/identity.js';
import { fingerprintRemoteUrl } from '../repository/remote-url.js';

export const GLOBAL_REPOSITORY_ID = 'kiokuko_global';
export const GLOBAL_WORKSPACE = 'global';

export interface ResolvedProjectWorkspace {
  repositoryRoot: string;
  repositoryId: string;
  workspace: string;
  source: RootSource | 'location' | 'remote' | 'local-path';
}

interface RepositoryRow extends SqliteRow {
  repositoryId: string;
  workspace: string;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

function displayName(repositoryRoot: string): string {
  return path.basename(repositoryRoot) || 'repository';
}

export function ensureGlobalWorkspace(database: SqliteDatabase, now = new Date().toISOString()): void {
  database.prepare(`
    INSERT OR IGNORE INTO repositories (
      repository_id, workspace, display_name, remote_fingerprint,
      binding_schema_version, agent_template_version, created_at, last_used_at
    ) VALUES (?, ?, ?, NULL, 1, 0, ?, ?)
  `).run(GLOBAL_REPOSITORY_ID, GLOBAL_WORKSPACE, 'Global memory', now, now);
  const row = database.prepare('SELECT workspace FROM repositories WHERE repository_id = ?').get<{ workspace: string }>(GLOBAL_REPOSITORY_ID);
  if (!row) throw new KiokukoError('CONFLICT', 'The reserved global workspace is already bound to another repository');
  if (row.workspace !== GLOBAL_WORKSPACE) throw new KiokukoError('CONFLICT', 'The reserved global repository ID is bound to another workspace');
  database.prepare('UPDATE repositories SET last_used_at = ? WHERE repository_id = ?').run(now, GLOBAL_REPOSITORY_ID);
}

function registerResolved(
  database: SqliteDatabase,
  repositoryRoot: string,
  repositoryId: string,
  workspace: string,
  remoteFingerprint: string | null,
  source: ResolvedProjectWorkspace['source'],
): ResolvedProjectWorkspace {
  registerRepositoryAndLocation(database, {
    repositoryId,
    workspace,
    displayName: displayName(repositoryRoot),
    canonicalRoot: repositoryRoot,
    remoteFingerprint,
    bindingSchemaVersion: 1,
    agentTemplateVersion: 0,
  });
  return { repositoryRoot, repositoryId, workspace, source };
}

/**
 * Resolve the current repository without requiring `kiokuko-ai use` and persist only
 * the path-to-workspace mapping in the global database. No repository file is written.
 */
export async function resolveProjectWorkspace(
  database: SqliteDatabase,
  cwd = process.cwd(),
): Promise<ResolvedProjectWorkspace | undefined> {
  let detected: ReturnType<typeof detectRepositoryRoot>;
  try {
    detected = detectRepositoryRoot({ cwd });
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
  const repositoryRoot = detected.root;

  if (detected.source === 'binding') {
    const binding = await readProjectConfig(path.join(repositoryRoot, '.kiokuko.json'));
    return registerResolved(database, repositoryRoot, binding.repositoryId, binding.workspace, null, 'binding');
  }

  const location = database.prepare(`
    SELECT r.repository_id AS repositoryId, r.workspace AS workspace
    FROM repository_locations l
    JOIN repositories r ON r.repository_id = l.repository_id
    WHERE l.canonical_root = ?
  `).get<RepositoryRow>(repositoryRoot);
  if (location) {
    return registerResolved(database, repositoryRoot, location.repositoryId, location.workspace, null, 'location');
  }

  const remote = readGitOrigin(repositoryRoot);
  if (remote) {
    const remoteFingerprint = fingerprintRemoteUrl(remote);
    const remoteOwner = database.prepare(`
      SELECT repository_id AS repositoryId, workspace
      FROM repositories
      WHERE remote_fingerprint = ?
      ORDER BY last_used_at DESC, repository_id ASC
      LIMIT 1
    `).get<RepositoryRow>(remoteFingerprint);
    if (remoteOwner) {
      return registerResolved(database, repositoryRoot, remoteOwner.repositoryId, remoteOwner.workspace, remoteFingerprint, 'remote');
    }
    const identity = createRepositoryIdentity({ repositoryRoot, remoteUrl: remote });
    return registerResolved(database, repositoryRoot, identity.repositoryId, identity.workspace, identity.remoteFingerprint, 'remote');
  }

  const repositoryId = `repo_local_${shortHash(repositoryRoot)}`;
  const identity = createRepositoryIdentity({ repositoryRoot, repositoryId });
  return registerResolved(database, repositoryRoot, identity.repositoryId, identity.workspace, null, 'local-path');
}

/**
 * Resolve a repository for a read-only lookup without registering its path,
 * updating last-used timestamps, or creating a repository row.
 *
 * The normal resolver intentionally persists this mapping so later commands
 * can reuse the same project identity. A read-only lookup must not turn an
 * untrusted cwd input into database state.
 */
export async function resolveProjectWorkspaceReadOnly(
  database: SqliteDatabase,
  cwd = process.cwd(),
): Promise<ResolvedProjectWorkspace | undefined> {
  let detected: ReturnType<typeof detectRepositoryRoot>;
  try {
    detected = detectRepositoryRoot({ cwd });
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
  const repositoryRoot = detected.root;

  if (detected.source === 'binding') {
    const binding = await readProjectConfig(path.join(repositoryRoot, '.kiokuko.json'));
    return {
      repositoryRoot,
      repositoryId: binding.repositoryId,
      workspace: binding.workspace,
      source: 'binding',
    };
  }

  const location = database.prepare(`
    SELECT r.repository_id AS repositoryId, r.workspace AS workspace
    FROM repository_locations l
    JOIN repositories r ON r.repository_id = l.repository_id
    WHERE l.canonical_root = ?
  `).get<RepositoryRow>(repositoryRoot);
  if (location) {
    return { repositoryRoot, repositoryId: location.repositoryId, workspace: location.workspace, source: 'location' };
  }

  const remote = readGitOrigin(repositoryRoot);
  if (remote) {
    const remoteFingerprint = fingerprintRemoteUrl(remote);
    const remoteOwner = database.prepare(`
      SELECT repository_id AS repositoryId, workspace
      FROM repositories
      WHERE remote_fingerprint = ?
      ORDER BY last_used_at DESC, repository_id ASC
      LIMIT 1
    `).get<RepositoryRow>(remoteFingerprint);
    if (remoteOwner) {
      return { repositoryRoot, repositoryId: remoteOwner.repositoryId, workspace: remoteOwner.workspace, source: 'remote' };
    }
    const identity = createRepositoryIdentity({ repositoryRoot, remoteUrl: remote });
    return {
      repositoryRoot,
      repositoryId: identity.repositoryId,
      workspace: identity.workspace,
      source: 'remote',
    };
  }

  const repositoryId = `repo_local_${shortHash(repositoryRoot)}`;
  const identity = createRepositoryIdentity({ repositoryRoot, repositoryId });
  return {
    repositoryRoot,
    repositoryId: identity.repositoryId,
    workspace: identity.workspace,
    source: 'local-path',
  };
}

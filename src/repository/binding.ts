import { existsSync } from 'node:fs';
import { KiokukoError } from '../errors.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { validateRepositoryBindingIdentity } from './identity-value.js';

export interface RepositoryRegistration {
  repositoryId: string;
  workspace: string;
  displayName: string;
  canonicalRoot: string;
  remoteFingerprint: string | null;
  bindingSchemaVersion: number;
  agentTemplateVersion: number;
  /** Exact current owner required before moving an existing canonical root. */
  rebindFrom?: {
    repositoryId: string;
    workspace: string;
  };
  now?: string;
}

export interface RegistrationResult {
  created: boolean;
  repositoryId: string;
  workspace: string;
  canonicalRoot: string;
}

function conflict(message: string): never {
  throw new KiokukoError('CONFLICT', message);
}

function requireSingleChange(database: SqliteDatabase, message: string): void {
  const changes = database.prepare('SELECT changes() AS changes').get<{ changes: unknown }>()?.changes;
  if (changes !== 1 && changes !== 1n) conflict(message);
}

function validateRegistrationVersions(registration: RepositoryRegistration): void {
  if (!Number.isSafeInteger(registration.bindingSchemaVersion)
    || registration.bindingSchemaVersion < 1) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      'bindingSchemaVersion must be a positive safe integer',
    );
  }
  // Zero is the explicit sentinel used by location-only discovery, which does
  // not claim that an agent template was installed or request a downgrade.
  if (!Number.isSafeInteger(registration.agentTemplateVersion)
    || registration.agentTemplateVersion < 0) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      'agentTemplateVersion must be a non-negative safe integer',
    );
  }
}

interface StoredVersionMetadata {
  bindingSchemaVersion: unknown;
  agentTemplateVersion: unknown;
}

export interface RepositoryLocation extends Record<string, unknown> {
  repositoryId: string;
  canonicalRoot: string;
}

export function listRepositoryLocations(database: SqliteDatabase): RepositoryLocation[] {
  return database.prepare(`
    SELECT repository_id AS repositoryId, canonical_root AS canonicalRoot
      FROM repository_locations
     ORDER BY canonical_root
  `).all<RepositoryLocation>();
}

export function findMissingRepositoryLocations(database: SqliteDatabase): RepositoryLocation[] {
  return listRepositoryLocations(database).filter((location) => !existsSync(location.canonicalRoot));
}

/** Remove only confirmed location rows whose roots are still absent. */
export function removeMissingRepositoryLocations(
  database: SqliteDatabase,
  candidates: readonly RepositoryLocation[],
): number {
  return withImmediateTransaction(database, () => {
    let removed = 0;
    for (const candidate of candidates) {
      if (existsSync(candidate.canonicalRoot)) continue;
      database
        .prepare('DELETE FROM repository_locations WHERE repository_id = ? AND canonical_root = ?')
        .run(candidate.repositoryId, candidate.canonicalRoot);
      const changes = database.prepare('SELECT changes() AS changes').get<{ changes: unknown }>()?.changes;
      if (changes !== 1 && changes !== 1n) {
        throw new KiokukoError('CONFLICT', 'Repository location changed before missing binding cleanup');
      }
      removed += 1;
    }
    return removed;
  });
}

function validateStoredVersions(metadata: StoredVersionMetadata): asserts metadata is {
  bindingSchemaVersion: number;
  agentTemplateVersion: number;
} {
  if (typeof metadata.bindingSchemaVersion !== 'number'
    || !Number.isSafeInteger(metadata.bindingSchemaVersion)
    || metadata.bindingSchemaVersion < 1
    || typeof metadata.agentTemplateVersion !== 'number'
    || !Number.isSafeInteger(metadata.agentTemplateVersion)
    || metadata.agentTemplateVersion < 0) {
    throw new KiokukoError(
      'INTEGRITY_ERROR',
      'Stored repository binding version metadata is invalid',
    );
  }
}

function rejectsStoredAgentVersion(
  storedAgentTemplateVersion: number,
  requestedAgentTemplateVersion: number,
): boolean {
  return requestedAgentTemplateVersion > 0
    && storedAgentTemplateVersion > requestedAgentTemplateVersion;
}

export function registerRepositoryAndLocation(
  database: SqliteDatabase,
  registration: RepositoryRegistration,
): RegistrationResult {
  validateRegistrationVersions(registration);
  validateRepositoryBindingIdentity(registration.repositoryId, registration.workspace);
  if (registration.rebindFrom !== undefined) {
    validateRepositoryBindingIdentity(
      registration.rebindFrom.repositoryId,
      registration.rebindFrom.workspace,
    );
    if (registration.rebindFrom.repositoryId === registration.repositoryId
      && registration.rebindFrom.workspace === registration.workspace) {
      conflict('Rebind target must differ from the current project binding');
    }
  }
  const now = registration.now ?? new Date().toISOString();
  if (registration.remoteFingerprint !== null && !/^sha256:[a-f0-9]{64}$/.test(registration.remoteFingerprint)) {
    throw new KiokukoError('VALIDATION_ERROR', 'remoteFingerprint must be a SHA-256 fingerprint');
  }
  return withImmediateTransaction(database, () => {
    const location = database
      .prepare(`
        SELECT l.repository_id AS repositoryId, r.workspace AS workspace,
               r.binding_schema_version AS bindingSchemaVersion,
               r.agent_template_version AS agentTemplateVersion
        FROM repository_locations l
        JOIN repositories r ON r.repository_id = l.repository_id
        WHERE l.canonical_root = ?
      `)
      .get<{
        repositoryId: string;
        workspace: string;
        bindingSchemaVersion: unknown;
        agentTemplateVersion: unknown;
      }>(registration.canonicalRoot);
    if (location !== undefined) validateStoredVersions(location);
    const rebindFrom = registration.rebindFrom;
    if (rebindFrom !== undefined) {
      if (location === undefined
        || location.repositoryId !== rebindFrom.repositoryId
        || location.workspace !== rebindFrom.workspace) {
        conflict('Repository root changed after rebind planning');
      }
    } else if (location && location.repositoryId !== registration.repositoryId) {
      conflict('Repository root is already bound to another repository ID; rebind is required');
    }
    if (location !== undefined
      && (location.bindingSchemaVersion > registration.bindingSchemaVersion
        || rejectsStoredAgentVersion(
          location.agentTemplateVersion,
          registration.agentTemplateVersion,
        ))) {
      conflict('Repository root is owned by a newer binding or agent-template version');
    }

    const repository = database
      .prepare(`
        SELECT workspace, binding_schema_version AS bindingSchemaVersion,
               agent_template_version AS agentTemplateVersion
        FROM repositories
        WHERE repository_id = ?
      `)
      .get<{
        workspace: string;
        bindingSchemaVersion: unknown;
        agentTemplateVersion: unknown;
      }>(registration.repositoryId);
    if (repository !== undefined) validateStoredVersions(repository);
    if (repository && repository.workspace !== registration.workspace) {
      conflict('Repository ID is already bound to another workspace');
    }
    if (repository !== undefined
      && (repository.bindingSchemaVersion > registration.bindingSchemaVersion
        || rejectsStoredAgentVersion(
          repository.agentTemplateVersion,
          registration.agentTemplateVersion,
        ))) {
      conflict('Repository ID uses a newer binding or agent-template version');
    }
    const expectedAgentTemplateVersion = repository === undefined
      ? registration.agentTemplateVersion
      : Math.max(repository.agentTemplateVersion, registration.agentTemplateVersion);

    const workspace = database
      .prepare('SELECT repository_id FROM repositories WHERE workspace = ?')
      .get<{ repository_id: string }>(registration.workspace);
    if (workspace && workspace.repository_id !== registration.repositoryId) {
      conflict('Workspace is already bound to another repository ID');
    }

    const created = !repository;
    if (created) {
      database
        .prepare(`
          INSERT INTO repositories (
            repository_id, workspace, display_name, remote_fingerprint,
            binding_schema_version, agent_template_version, created_at, last_used_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          registration.repositoryId,
          registration.workspace,
          registration.displayName,
          registration.remoteFingerprint,
          registration.bindingSchemaVersion,
          registration.agentTemplateVersion,
          now,
          now,
        );
    } else {
      database
        .prepare('UPDATE repositories SET last_used_at = ?, display_name = ?, agent_template_version = MAX(agent_template_version, ?) WHERE repository_id = ?')
        .run(now, registration.displayName, registration.agentTemplateVersion, registration.repositoryId);
      requireSingleChange(database, 'Repository metadata changed after registration planning');
    }

    if (!location) {
      database
        .prepare(`
          INSERT INTO repository_locations (
            repository_id, canonical_root, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?)
        `)
        .run(registration.repositoryId, registration.canonicalRoot, now, now);
    } else if (location.repositoryId === registration.repositoryId) {
      database
        .prepare('UPDATE repository_locations SET last_seen_at = ? WHERE repository_id = ? AND canonical_root = ?')
        .run(now, registration.repositoryId, registration.canonicalRoot);
      requireSingleChange(database, 'Repository location changed after registration planning');
    } else {
      database
        .prepare(`
          UPDATE repository_locations
          SET repository_id = ?, last_seen_at = ?
          WHERE repository_id = ? AND canonical_root = ?
        `)
        .run(
          registration.repositoryId,
          now,
          location.repositoryId,
          registration.canonicalRoot,
        );
      requireSingleChange(database, 'Repository location changed after rebind planning');
    }
    const registeredLocation = database
      .prepare(`
        SELECT l.repository_id AS repositoryId, r.workspace AS workspace,
               r.binding_schema_version AS bindingSchemaVersion,
               r.agent_template_version AS agentTemplateVersion
        FROM repository_locations l
        JOIN repositories r ON r.repository_id = l.repository_id
        WHERE l.canonical_root = ?
      `)
      .get<{
        repositoryId: string;
        workspace: string;
        bindingSchemaVersion: unknown;
        agentTemplateVersion: unknown;
      }>(registration.canonicalRoot);
    if (registeredLocation !== undefined) validateStoredVersions(registeredLocation);
    if (registeredLocation?.repositoryId !== registration.repositoryId
      || registeredLocation.workspace !== registration.workspace) {
      conflict('Repository location did not commit the planned binding identity');
    }
    if (registeredLocation.bindingSchemaVersion !== registration.bindingSchemaVersion
      || registeredLocation.agentTemplateVersion !== expectedAgentTemplateVersion) {
      conflict('Repository location did not commit the planned binding version metadata');
    }
    return {
      created,
      repositoryId: registration.repositoryId,
      workspace: registration.workspace,
      canonicalRoot: registration.canonicalRoot,
    };
  });
}

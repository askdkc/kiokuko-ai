import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { readEntry } from '../memory/entries.js';
import {
  activeExternalSkillReferenceCandidateSql,
  externalSkillReferenceCandidateSql,
  isFederatedEcosystemCandidate,
} from '../memory/federated-retrieval.js';
import { isRetrievableEntry } from '../memory/hybrid-retrieval.js';
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js';
import { isExternalSkillReference, readExternalSkill } from '../skills/store.js';
import { isCuratorManagedGlobalMemory } from '../memory/curator-trust.js';
import { contextFeedbackSignals } from './feedback.js';
import { readActiveEmbeddingProfile, readEmbeddingRuntimeState, readEntryEmbedding, type ActiveEmbeddingProfile } from '../embedding/store.js';

export const CONTEXT_SELECTION_STATE_MAX_ENTRIES = 10_000;
const MAX_SELECTION_WORKSPACES = 2;
const MAX_WORKSPACE_BYTES = 256;
const CONTROL_CHARACTERS = /\p{C}/u;

function normalizedWorkspaces(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_SELECTION_WORKSPACES) {
    throw new KiokukoError('VALIDATION_ERROR', 'Context selection workspaces are invalid');
  }
  const workspaces = value.map((workspace) => {
    if (typeof workspace !== 'string'
      || workspace.length === 0
      || workspace.trim() !== workspace
      || CONTROL_CHARACTERS.test(workspace)
      || Buffer.byteLength(workspace, 'utf8') > MAX_WORKSPACE_BYTES) {
      throw new KiokukoError('VALIDATION_ERROR', 'Context selection workspaces are invalid');
    }
    return workspace;
  });
  if (new Set(workspaces).size !== workspaces.length) {
    throw new KiokukoError('VALIDATION_ERROR', 'Context selection workspaces are invalid');
  }
  return workspaces.sort(compareCanonicalStrings);
}

function assertExternalEntryMappings(
  database: SqliteDatabase,
  workspaces: readonly string[],
  workspacePredicate: string,
  externalMarker: string,
): void {
  const mappedOrdinary = database.prepare(`
    SELECT e.id
      FROM entries AS e
     WHERE e.workspace IN (${workspacePredicate})
       AND e.status <> 'superseded'
       AND NOT ${externalMarker}
       AND EXISTS (
         SELECT 1 FROM external_skill_entries AS mapping WHERE mapping.entry_id = e.id
       )
     LIMIT 1
  `).get<{ id: unknown }>(...workspaces);
  if (mappedOrdinary !== undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'A managed external skill mapping points to an ordinary entry');
  }
  const corruptExternal = database.prepare(`
    SELECT e.id
      FROM entries AS e
     WHERE e.workspace IN (${workspacePredicate})
       AND e.status <> 'superseded'
       AND ${externalMarker}
       AND (
         (SELECT COUNT(*) FROM external_skill_entries AS mapping WHERE mapping.entry_id = e.id) <> 1
         OR NOT EXISTS (
           SELECT 1
             FROM external_skill_entries AS mapping
             JOIN external_skills AS skill ON skill.skill_id = mapping.skill_id
             JOIN entry_revisions AS revision
               ON revision.entry_id = mapping.entry_id
              AND revision.revision = mapping.entry_revision
            WHERE mapping.entry_id = e.id
              AND mapping.entry_revision = e.current_revision
              AND mapping.content_hash = revision.content_hash
              AND revision.workspace = e.workspace
         )
       )
     LIMIT 1
  `).get<{ id: unknown }>(...workspaces);
  if (corruptExternal !== undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context external entry mapping is missing');
  }
}

function searchSignalSnapshot(database: SqliteDatabase, entryId: string): Array<{ type: string; value: string }> {
  const rows = database.prepare(`
    SELECT signal_type AS type, normalized_value AS value
      FROM entry_search_signals
     WHERE entry_id = ?
     ORDER BY signal_type ASC, normalized_value ASC
  `).all<{ type: unknown; value: unknown }>(entryId);
  return rows.map((row) => {
    if (typeof row.type !== 'string' || row.type.length === 0
      || typeof row.value !== 'string' || row.value.length === 0) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored context search signal is invalid');
    }
    return { type: row.type, value: row.value };
  });
}

function externalSkillSnapshot(database: SqliteDatabase, entryId: string): Record<string, unknown> | null {
  const mappings = database.prepare(`
    SELECT skill_id AS skillId, source_path AS sourcePath, chunk_index AS chunkIndex,
           entry_revision AS entryRevision, content_hash AS contentHash,
           primary_document AS primaryDocument, active, imported_at AS importedAt
      FROM external_skill_entries
     WHERE entry_id = ?
     ORDER BY skill_id ASC, source_path ASC, chunk_index ASC
  `).all<Record<string, unknown>>(entryId);
  if (mappings.length === 0) return null;
  const skillIds = [...new Set(mappings.map((mapping) => mapping.skillId))];
  if (skillIds.length !== 1 || typeof skillIds[0] !== 'string') {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context external entry mapping is invalid');
  }
  const detail = readExternalSkill(database, skillIds[0]);
  if (detail === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context external entry parent is missing');
  }
  return { skill: detail.skill, mappings };
}

interface SemanticProjectionState {
  activeProfileId: string | null;
  generation: number | null;
  profile: {
    dimensions: number;
    distanceMetric: string;
    documentTemplateVersion: number;
    queryTemplateVersion: number;
    distanceCeiling: number;
  } | null;
  activeProfile: ActiveEmbeddingProfile | null;
}

function embeddingProjectionInstalled(database: SqliteDatabase): boolean {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
      FROM sqlite_master
     WHERE type = 'table'
       AND name IN ('embedding_profiles', 'embedding_runtime', 'entry_embeddings', 'embedding_jobs', 'query_embeddings')
  `).get<{ count: unknown }>();
  if (row === undefined || typeof row.count !== 'number' || !Number.isSafeInteger(row.count) || row.count < 0 || row.count > 5) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored embedding projection schema is invalid');
  }
  return row.count > 0;
}

function semanticProjectionState(database: SqliteDatabase): SemanticProjectionState {
  if (!embeddingProjectionInstalled(database)) {
    return { activeProfileId: null, generation: null, profile: null, activeProfile: null };
  }
  const runtime = readEmbeddingRuntimeState(database);
  const activeProfile = readActiveEmbeddingProfile(database);
  return {
    activeProfileId: activeProfile?.profile.profileId ?? null,
    generation: runtime.generation,
    profile: activeProfile === null ? null : {
      dimensions: activeProfile.profile.identity.dimensions,
      distanceMetric: activeProfile.profile.identity.distanceMetric,
      documentTemplateVersion: activeProfile.profile.identity.documentTemplateVersion,
      queryTemplateVersion: activeProfile.profile.identity.queryTemplateVersion,
      distanceCeiling: activeProfile.profile.identity.distanceCeiling,
    },
    activeProfile,
  };
}

function semanticProjectionSnapshotForState(
  database: SqliteDatabase,
  entry: ReturnType<typeof readEntry>,
  state: SemanticProjectionState,
): {
  activeProfileId: string | null;
  embedding: null | {
    profileId: string;
    revision: number;
    contentHash: string;
    documentHash: string;
    vectorHash: string;
    dimensions: number;
  };
} {
  if (state.activeProfile === null) return { activeProfileId: null, embedding: null };
  const stored = readEntryEmbedding(database, {
    entryId: entry.id,
    profileId: state.activeProfile.profile.profileId,
  });
  if (stored === undefined
    || stored.revision !== entry.revision
    || stored.contentHash !== entry.contentHash
    || stored.dimensions !== state.activeProfile.profile.identity.dimensions) {
    return { activeProfileId: state.activeProfile.profile.profileId, embedding: null };
  }
  return {
    activeProfileId: state.activeProfile.profile.profileId,
    embedding: {
      profileId: stored.profileId,
      revision: stored.revision,
      contentHash: stored.contentHash,
      documentHash: stored.documentHash,
      vectorHash: stored.vectorHash,
      dimensions: stored.dimensions,
    },
  };
}

export function semanticProjectionSnapshot(
  database: SqliteDatabase,
  entry: ReturnType<typeof readEntry>,
): {
  activeProfileId: string | null;
  embedding: null | {
    profileId: string;
    revision: number;
    contentHash: string;
    documentHash: string;
    vectorHash: string;
    dimensions: number;
  };
} {
  return semanticProjectionSnapshotForState(database, entry, semanticProjectionState(database));
}

function selectionEntrySnapshot(
  database: SqliteDatabase,
  entry: ReturnType<typeof readEntry>,
  semanticState: SemanticProjectionState | null,
): Record<string, unknown> {
  const external = isExternalSkillReference(entry) ? externalSkillSnapshot(database, entry.id) : null;
  return {
    id: entry.id,
    workspace: entry.workspace,
    revision: entry.revision,
    kind: entry.kind,
    status: entry.status,
    trustLevel: entry.trustLevel,
    confidence: entry.confidence,
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    tags: [...entry.tags],
    scope: entry.scope,
    provenance: entry.provenance,
    contentHash: entry.contentHash,
    supersededBy: entry.supersededBy,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    verifiedAt: entry.verifiedAt,
    searchSignals: searchSignalSnapshot(database, entry.id),
    ...(external === null ? {} : { external }),
    feedback: contextFeedbackSignals(database, entry.id),
    ...(semanticState === null ? {} : { semantic: semanticProjectionSnapshotForState(database, entry, semanticState) }),
  };
}

interface CandidateStateOptions {
  includeEcosystem: boolean;
  includeExternal: boolean;
  includeTrustedCurator: boolean;
  includeSemantic: boolean;
}

function contextCandidateState(
  database: SqliteDatabase,
  relevantWorkspaces: readonly string[],
  options: CandidateStateOptions,
): { workspaces: string[]; entries: Record<string, unknown>[]; semantic: Omit<SemanticProjectionState, 'activeProfile'> } {
  const workspaces = normalizedWorkspaces(relevantWorkspaces);
  const semanticState = options.includeSemantic ? semanticProjectionState(database) : null;
  const emptySemantic = { activeProfileId: null, generation: null, profile: null } as const;
  if (workspaces.length === 0 && !options.includeEcosystem) {
    return { workspaces, entries: [], semantic: semanticState === null ? emptySemantic : {
      activeProfileId: semanticState.activeProfileId,
      generation: semanticState.generation,
      profile: semanticState.profile,
    } };
  }
  const workspacePredicate = workspaces.map(() => '?').join(', ');
  const externalMarker = externalSkillReferenceCandidateSql();
  const activeExternal = activeExternalSkillReferenceCandidateSql();
  if (workspaces.length > 0) {
    assertExternalEntryMappings(database, workspaces, workspacePredicate, externalMarker);
  }
  if (options.includeEcosystem) {
    const mappedOrdinary = database.prepare(`
      SELECT e.id
        FROM external_skill_entries AS mapping
        JOIN entries AS e ON e.id = mapping.entry_id
       WHERE mapping.active = 1
         AND e.status <> 'superseded'
         AND NOT ${externalMarker}
       LIMIT 1
    `).get<{ id: unknown }>();
    if (mappedOrdinary !== undefined) {
      throw new KiokukoError('INTEGRITY_ERROR', 'A managed external skill mapping points to an ordinary entry');
    }
  }

  const clauses: string[] = [];
  const parameters: string[] = [];
  if (workspaces.length > 0) {
    clauses.push(`(e.workspace IN (${workspacePredicate}) AND NOT ${externalMarker})`);
    parameters.push(...workspaces);
  }
  if (options.includeExternal) {
    const externalWorkspace = options.includeEcosystem
      ? '1'
      : workspaces.length === 0
        ? '0'
        : `e.workspace IN (${workspacePredicate})`;
    clauses.push(`(${activeExternal}
      AND ${externalWorkspace}
    )`);
    if (!options.includeEcosystem && workspaces.length > 0) parameters.push(...workspaces);
  }
  if (options.includeEcosystem) {
    const semanticCandidate = semanticState?.activeProfileId === null || semanticState === null
      ? ''
      : `OR EXISTS (
        SELECT 1
          FROM entry_embeddings AS embedding
          JOIN entry_revisions AS semantic_revision
            ON semantic_revision.entry_id = e.id
           AND semantic_revision.revision = e.current_revision
         WHERE embedding.entry_id = e.id
           AND embedding.profile_id = ?
           AND embedding.revision = e.current_revision
           AND embedding.content_hash = semantic_revision.content_hash
      )`;
    clauses.push(`(NOT ${externalMarker}
      AND EXISTS (
        SELECT 1 FROM entry_search_signals AS signal WHERE signal.entry_id = e.id
      ))`);
    if (semanticCandidate.length > 0) {
      clauses[clauses.length - 1] = `(NOT ${externalMarker}
        AND (
          EXISTS (
            SELECT 1 FROM entry_search_signals AS signal WHERE signal.entry_id = e.id
          )
          ${semanticCandidate}
        ))`;
      parameters.push(semanticState!.activeProfileId!);
    }
  }
  if (clauses.length === 0) return { workspaces, entries: [], semantic: semanticState === null ? emptySemantic : {
    activeProfileId: semanticState.activeProfileId,
    generation: semanticState.generation,
    profile: semanticState.profile,
  } };
  const rows = database.prepare(`
    SELECT e.id, e.workspace, CASE WHEN ${externalMarker} THEN 1 ELSE 0 END AS isExternal
      FROM entries AS e
     WHERE e.status <> 'superseded'
       AND (${clauses.join(' OR ')})
     ORDER BY e.workspace ASC, e.id ASC
     LIMIT ?
  `).all<{ id: unknown; workspace: unknown; isExternal: unknown }>(
    ...parameters,
    CONTEXT_SELECTION_STATE_MAX_ENTRIES + 1,
  );
  if (rows.length > CONTEXT_SELECTION_STATE_MAX_ENTRIES) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Context selection state exceeds the policy bound');
  }
  const relevant = new Set(workspaces);
  const entries = rows.flatMap((row) => {
    if (typeof row.id !== 'string'
      || typeof row.workspace !== 'string'
      || row.isExternal !== 0 && row.isExternal !== 1) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored context selection state is invalid');
    }
    const entry = readEntry(
      database,
      { workspace: row.workspace, entryId: row.id },
      // Managed external entries require the current structured scope shape.
      { requireStructuredScope: row.isExternal === 1 },
    );
    if (entry.status === 'superseded') return [];
    const local = relevant.has(entry.workspace);
    const external = isExternalSkillReference(entry);
    if (external && !options.includeExternal) return [];
    if (isCuratorManagedGlobalMemory(entry) && !options.includeTrustedCurator) return [];
    const retrievable = local
      ? isRetrievableEntry(database, entry)
      : options.includeEcosystem && isFederatedEcosystemCandidate(database, entry);
    if (!retrievable) return [];
     return [selectionEntrySnapshot(database, entry, semanticState)];
  });
  return {
    workspaces,
    entries,
    semantic: semanticState === null ? emptySemantic : {
      activeProfileId: semanticState.activeProfileId,
      generation: semanticState.generation,
      profile: semanticState.profile,
    },
  };
}

/**
 * Hash the bounded ordinary-memory corpus that can affect capability gating.
 * Managed external references and deterministic Curator global projections are
 * deliberately excluded because neither requires memory-reasoning.
 */
export function ordinaryContextSelectionStateHash(
  database: SqliteDatabase,
  relevantWorkspaces: readonly string[],
  options: { includeEcosystem?: boolean } = {},
): string {
  const state = contextCandidateState(database, relevantWorkspaces, {
    includeEcosystem: options.includeEcosystem === true,
    includeExternal: false,
    includeTrustedCurator: false,
    includeSemantic: false,
  });
  return canonicalContentHash({
    workspaces: state.workspaces,
    includeEcosystem: options.includeEcosystem === true,
    entries: state.entries,
  });
}

/**
 * Hash every currently retrievable entry that can affect broker ranking or replay.
 * This is deliberately broader than the ordinary-memory capability gate above:
 * managed external Skill entries are context inputs and therefore part of this
 * state identity whenever their exact current mapping is active.
 */
export function contextRetrievalStateHash(
  database: SqliteDatabase,
  relevantWorkspaces: readonly string[],
  options: { includeEcosystem?: boolean } = {},
): string {
  const includeEcosystem = options.includeEcosystem === true;
  const state = contextCandidateState(database, relevantWorkspaces, {
    includeEcosystem,
    includeExternal: true,
    includeTrustedCurator: true,
    includeSemantic: true,
  });
  return canonicalContentHash({
    workspaces: state.workspaces,
    includeEcosystem,
    semantic: state.semantic,
    entries: state.entries,
  });
}

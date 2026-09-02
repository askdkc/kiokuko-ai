import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { requireWorkspace } from '../serialization/validate.js';
import { decodeVector, encodeVector, normalizeVector } from './vector.js';
import { activeEmbeddingSearchProfile, assertEmbeddingDocumentHash, MAX_VECTOR_SEARCH_LIMIT } from './javascript-backend.js';
import type { VectorHit, VectorSearchBackend, VectorSearchInput } from './types.js';

export const SQLITE_VEC_BACKEND_ID = 'sqlite-vec' as const;

interface VectorRow extends SqliteRow {
  entry_id: unknown;
  workspace: unknown;
  dimensions: unknown;
  embedding: unknown;
  vector_hash: unknown;
  document_hash: unknown;
  distance: unknown;
}

function invalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function integrity(message: string): never {
  throw new KiokukoError('INTEGRITY_ERROR', message);
}

function entryId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    integrity('Stored vector entry ID is invalid');
  }
  return value;
}

function searchInput(input: VectorSearchInput): {
  profileId: string;
  dimensions: number;
  queryVector: Float32Array;
  queryBlob: Uint8Array;
  distanceCeiling: number;
  workspace: string | undefined;
  excludedWorkspaces: string[];
  limit: number;
} {
  if (typeof input.profileId !== 'string' || !/^[0-9a-f]{64}$/u.test(input.profileId)) invalid('profileId is invalid');
  if (!Number.isSafeInteger(input.dimensions) || input.dimensions < 2 || input.dimensions > 8192) invalid('dimensions is invalid');
  if (!Number.isFinite(input.distanceCeiling) || input.distanceCeiling <= 0 || input.distanceCeiling >= 2) invalid('distanceCeiling is invalid');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_VECTOR_SEARCH_LIMIT) invalid('limit is invalid');
  const queryVector = normalizeVector(input.queryVector, input.dimensions);
  const workspace = input.workspace === undefined ? undefined : requireWorkspace(input.workspace);
  const excludedWorkspaces = input.excludedWorkspaces === undefined
    ? []
    : [...new Set(input.excludedWorkspaces.map((value) => requireWorkspace(value)))];
  return {
    profileId: input.profileId,
    dimensions: input.dimensions,
    queryVector,
    queryBlob: encodeVector(queryVector, input.dimensions),
    distanceCeiling: input.distanceCeiling,
    workspace,
    excludedWorkspaces,
    limit: input.limit,
  };
}

export class SqliteVecVectorSearchBackend implements VectorSearchBackend {
  readonly id = SQLITE_VEC_BACKEND_ID;

  search(database: SqliteDatabase, input: VectorSearchInput): VectorHit[] {
    const normalized = searchInput(input);
    const profile = activeEmbeddingSearchProfile(database, normalized.profileId, normalized.dimensions);
    if (profile === null) return [];
    const clauses = [
      'ee.profile_id = ?',
      'ee.dimensions = ?',
      'ee.revision = e.current_revision',
      'ee.content_hash = r.content_hash',
    ];
    const parameters: Array<string | number | Uint8Array> = [normalized.queryBlob, normalized.profileId, normalized.dimensions];
    if (normalized.workspace !== undefined) {
      clauses.push('e.workspace = ?');
      parameters.push(normalized.workspace);
    }
    if (normalized.excludedWorkspaces.length > 0) {
      clauses.push(`e.workspace NOT IN (${normalized.excludedWorkspaces.map(() => '?').join(', ')})`);
      parameters.push(...normalized.excludedWorkspaces);
    }
    parameters.push(normalized.limit);

    let rows: VectorRow[];
    try {
      rows = database.prepare(`
        SELECT ee.entry_id, e.workspace, ee.dimensions, ee.embedding,
               ee.vector_hash, ee.document_hash,
               vec_distance_cosine(ee.embedding, ?) AS distance
          FROM entry_embeddings AS ee
          JOIN entries AS e
            ON e.id = ee.entry_id
          JOIN entry_revisions AS r
            ON r.entry_id = e.id
           AND r.revision = e.current_revision
         WHERE ${clauses.join(' AND ')}
         ORDER BY distance ASC, ee.entry_id ASC
         LIMIT ?
      `).all<VectorRow>(...parameters);
    } catch (error) {
      const failure = new KiokukoError('SERVICE_UNAVAILABLE', 'sqlite-vec vector search is unavailable');
      Object.defineProperty(failure, 'cause', { value: error });
      throw failure;
    }

    const hits: VectorHit[] = [];
    for (const row of rows) {
      const id = entryId(row.entry_id);
      if (typeof row.workspace !== 'string' || row.workspace.length === 0) integrity('Stored vector workspace is invalid');
      if (typeof row.dimensions !== 'number' || row.dimensions !== normalized.dimensions) {
        integrity('Stored vector dimensions do not match the search profile');
      }
      const vectorHash = typeof row.vector_hash === 'string' ? row.vector_hash : integrity('Stored vector hash is invalid');
      assertEmbeddingDocumentHash(database, { profile, entryId: id, workspace: row.workspace, documentHash: row.document_hash });
      try {
        decodeVector(row.embedding, normalized.dimensions, vectorHash);
      } catch {
        integrity('Stored vector is invalid');
      }
      if (typeof row.distance !== 'number' || !Number.isFinite(row.distance)) integrity('Vector distance is invalid');
      if (row.distance <= normalized.distanceCeiling) hits.push({ entryId: id, distance: row.distance });
    }
    return hits;
  }
}

export const createSqliteVecVectorSearchBackend = (): VectorSearchBackend => new SqliteVecVectorSearchBackend();

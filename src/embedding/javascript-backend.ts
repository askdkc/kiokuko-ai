import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { readEntry } from '../memory/entries.js';
import { requireWorkspace } from '../serialization/validate.js';
import { buildEmbeddingDocumentForProfile } from './document.js';
import { readActiveEmbeddingProfile } from './store.js';
import { decodeVector, cosineDistance, normalizeVector } from './vector.js';
import type { EmbeddingProfile, VectorHit, VectorSearchBackend, VectorSearchInput } from './types.js';

export const JAVASCRIPT_BACKEND_ID = 'javascript';
export const MAX_JAVASCRIPT_BACKEND_ENTRIES = 10_000;
export const MAX_VECTOR_SEARCH_LIMIT = 120;

interface VectorRow extends SqliteRow {
  entry_id: unknown;
  workspace: unknown;
  dimensions: unknown;
  embedding: unknown;
  vector_hash: unknown;
  document_hash: unknown;
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
  distanceCeiling: number;
  workspace: string | undefined;
  excludedWorkspaces: string[];
  limit: number;
} {
  if (typeof input.profileId !== 'string' || !/^[0-9a-f]{64}$/u.test(input.profileId)) invalid('profileId is invalid');
  if (!Number.isSafeInteger(input.dimensions) || input.dimensions < 2 || input.dimensions > 8192) invalid('dimensions is invalid');
  if (!Number.isFinite(input.distanceCeiling) || input.distanceCeiling <= 0 || input.distanceCeiling >= 2) invalid('distanceCeiling is invalid');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_VECTOR_SEARCH_LIMIT) invalid('limit is invalid');
  const workspace = input.workspace === undefined ? undefined : requireWorkspace(input.workspace);
  const excludedWorkspaces = input.excludedWorkspaces === undefined
    ? []
    : [...new Set(input.excludedWorkspaces.map((value) => requireWorkspace(value)))];
  return {
    profileId: input.profileId,
    dimensions: input.dimensions,
    queryVector: normalizeVector(input.queryVector, input.dimensions),
    distanceCeiling: input.distanceCeiling,
    workspace,
    excludedWorkspaces,
    limit: input.limit,
  };
}

function worse(left: VectorHit, right: VectorHit): boolean {
  return left.distance > right.distance || left.distance === right.distance && left.entryId > right.entryId;
}

function better(left: VectorHit, right: VectorHit): boolean {
  return left.distance < right.distance || left.distance === right.distance && left.entryId < right.entryId;
}

/** Admit vectors only from the currently active profile and generation. */
export function activeEmbeddingSearchProfile(
  database: SqliteDatabase,
  profileId: string,
  dimensions: number,
): EmbeddingProfile | null {
  const active = readActiveEmbeddingProfile(database);
  if (active === null || active.profile.profileId !== profileId) return null;
  if (active.profile.identity.dimensions !== dimensions) integrity('Active embedding profile dimensions do not match the search profile');
  return active.profile;
}

/** Reject stored vectors whose source document no longer matches the profile contract. */
export function assertEmbeddingDocumentHash(
  database: SqliteDatabase,
  input: { profile: EmbeddingProfile; entryId: string; workspace: string; documentHash: unknown },
): void {
  if (typeof input.documentHash !== 'string' || !/^[0-9a-f]{64}$/u.test(input.documentHash)) integrity('Stored vector document hash is invalid');
  const entry = readEntry(database, { workspace: input.workspace, entryId: input.entryId });
  const document = buildEmbeddingDocumentForProfile({
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    tags: entry.tags,
    scope: entry.scope,
  }, input.profile.identity);
  if (document.documentHash !== input.documentHash) integrity('Stored vector document hash does not match the canonical entry');
}

class WorstFirstHeap {
  readonly #items: VectorHit[] = [];

  constructor(readonly limit: number) {}

  add(hit: VectorHit): void {
    if (this.#items.length < this.limit) {
      this.#items.push(hit);
      this.siftUp(this.#items.length - 1);
      return;
    }
    const worst = this.#items[0];
    if (worst === undefined || !better(hit, worst)) return;
    this.#items[0] = hit;
    this.siftDown(0);
  }

  values(): VectorHit[] {
    return [...this.#items].sort((left, right) => better(left, right) ? -1 : better(right, left) ? 1 : 0);
  }

  private siftUp(start: number): void {
    let child = start;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      const parentValue = this.#items[parent];
      const childValue = this.#items[child];
      if (parentValue === undefined || childValue === undefined || !worse(childValue, parentValue)) break;
      this.#items[parent] = childValue;
      this.#items[child] = parentValue;
      child = parent;
    }
  }

  private siftDown(start: number): void {
    let parent = start;
    for (;;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let largest = parent;
      const leftValue = this.#items[left];
      const rightValue = this.#items[right];
      const largestValue = this.#items[largest];
      if (leftValue !== undefined && largestValue !== undefined && worse(leftValue, largestValue)) largest = left;
      const candidate = this.#items[largest];
      if (rightValue !== undefined && candidate !== undefined && worse(rightValue, candidate)) largest = right;
      if (largest === parent) return;
      const parentValue = this.#items[parent];
      const replacement = this.#items[largest];
      if (parentValue === undefined || replacement === undefined) return;
      this.#items[parent] = replacement;
      this.#items[largest] = parentValue;
      parent = largest;
    }
  }
}

export class JavaScriptVectorSearchBackend implements VectorSearchBackend {
  readonly id = JAVASCRIPT_BACKEND_ID;

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
    const parameters: Array<string | number> = [normalized.profileId, normalized.dimensions];
    if (normalized.workspace !== undefined) {
      clauses.push('e.workspace = ?');
      parameters.push(normalized.workspace);
    }
    if (normalized.excludedWorkspaces.length > 0) {
      clauses.push(`e.workspace NOT IN (${normalized.excludedWorkspaces.map(() => '?').join(', ')})`);
      parameters.push(...normalized.excludedWorkspaces);
    }
    parameters.push(MAX_JAVASCRIPT_BACKEND_ENTRIES + 1);
    const rows = database.prepare(`
       SELECT ee.entry_id, e.workspace, ee.dimensions, ee.embedding,
              ee.vector_hash, ee.document_hash
        FROM entry_embeddings AS ee
        JOIN entries AS e ON e.id = ee.entry_id
        JOIN entry_revisions AS r
          ON r.entry_id = e.id AND r.revision = e.current_revision
       WHERE ${clauses.join(' AND ')}
       ORDER BY ee.entry_id ASC
       LIMIT ?
    `).all<VectorRow>(...parameters);
    if (rows.length > MAX_JAVASCRIPT_BACKEND_ENTRIES) {
      throw new KiokukoError('BACKPRESSURE', 'JavaScript vector search corpus exceeds its safety bound');
    }
    const heap = new WorstFirstHeap(normalized.limit);
    for (const row of rows) {
      const id = entryId(row.entry_id);
      if (typeof row.workspace !== 'string' || row.workspace.length === 0) integrity('Stored vector workspace is invalid');
      if (typeof row.dimensions !== 'number' || row.dimensions !== normalized.dimensions) integrity('Stored vector dimensions do not match the search profile');
      const vectorHash = typeof row.vector_hash === 'string' ? row.vector_hash : integrity('Stored vector hash is invalid');
      assertEmbeddingDocumentHash(database, { profile, entryId: id, workspace: row.workspace, documentHash: row.document_hash });
      let vector: Float32Array;
      try {
        vector = decodeVector(row.embedding, normalized.dimensions, vectorHash);
      } catch {
        integrity('Stored vector is invalid');
      }
      const distance = cosineDistance(normalized.queryVector, vector);
      if (!Number.isFinite(distance)) integrity('Vector distance is invalid');
      if (distance <= normalized.distanceCeiling) heap.add({ entryId: id, distance });
    }
    return heap.values();
  }
}

export const createJavaScriptVectorSearchBackend = (): VectorSearchBackend => new JavaScriptVectorSearchBackend();

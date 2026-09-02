import { randomUUID } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { readEntry, recordEntryInTransaction, type EntryRecord, type RecordEntryInput } from '../memory/entries.js';
import { findSecret } from '../memory/secrets.js';
import {
  canonicalContentHash,
  canonicalJson,
  validateRecordInput,
  type JsonObject,
} from '../serialization/validate.js';
import { MAX_EVENT_PAYLOAD_BYTES, MAX_ID_LENGTH } from './types.js';

const CONFIRMATION_REQUIRED = 'Explicit promotion confirmation is required';
const INVALID_INPUT = 'Invalid ledger promotion input';
const PROPOSAL_NOT_FOUND = 'Ledger proposal not found';
const INVALID_PROPOSAL = 'Invalid memory proposal';
const PROPOSAL_SECURITY_REJECTED = 'Proposal content was rejected by memory security policy';
const PROMOTION_CONFLICT = 'Ledger promotion conflicts with existing provenance';
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_REFERENCE_BYTES = 2 * 1024;
const PROMOTION_CONFIDENCE = 0.25;
// The proposal payload is deliberately limited to curated memory content fields.
const PROPOSAL_FIELDS = new Set(['kind', 'title', 'body', 'summary', 'scope', 'tags']);
const PROMOTION_INPUT_FIELDS = new Set(['workspace', 'runId', 'proposalEventId', 'deliveryId', 'actor', 'createdAt', 'confirmed']);

export interface LedgerMemoryLinkView {
  linkId: string;
  runId: string;
  eventId: string | null;
  deliveryId: string | null;
  entryId: string;
  createdAt: string;
  untrusted: true;
}

export interface LedgerPromotionResult {
  entry: EntryRecord;
  link: LedgerMemoryLinkView;
  untrusted: true;
}

type ValidatedPromotionInput = {
  workspace: string;
  runId: string;
  proposalEventId: string;
  deliveryId?: string;
  actor: string;
  createdAt: string;
};

type ProposalSource = {
  sequence: number;
  payload: unknown;
  deliveryId: string | null;
  intakeId: string | null;
};

type PreparedPromotion = {
  input: ValidatedPromotionInput;
  memoryInput: RecordEntryInput;
  contentHash: string;
  reference: string;
  source: ProposalSource;
};

type EventRow = SqliteRow & {
  sequence: number;
  event_type: string;
  payload_json: string;
};

type DeliveryRow = SqliteRow & {
  delivery_id: string;
  through_sequence: number;
  intake_session_id: string | null;
};

type ExistingEntryRow = SqliteRow & {
  id: string;
  status: string;
  trust_level: string;
};

type LinkRow = SqliteRow & {
  link_id: string;
  run_id: string;
  event_id: string | null;
  delivery_id: string | null;
  entry_id: string;
  created_at: string;
};

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function notFound(): never {
  throw new KiokukoError('NOT_FOUND', PROPOSAL_NOT_FOUND);
}

function conflict(): never {
  throw new KiokukoError('CONFLICT', PROMOTION_CONFLICT);
}

function invalidProposal(): never {
  throw new KiokukoError('VALIDATION_ERROR', INVALID_PROPOSAL);
}

function securityRejected(): never {
  throw new KiokukoError('SECURITY_REJECTION', PROPOSAL_SECURITY_REJECTED);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH || /\p{Cc}/u.test(value)) validation(INVALID_INPUT);
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) validation(INVALID_INPUT);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) validation(INVALID_INPUT);
  return value;
}

function parseInput(value: unknown): ValidatedPromotionInput {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !PROMOTION_INPUT_FIELDS.has(key))) validation(INVALID_INPUT);
  if (value.confirmed !== true) throw new KiokukoError('VALIDATION_ERROR', CONFIRMATION_REQUIRED);
  const workspace = boundedString(value.workspace);
  const runId = boundedString(value.runId);
  const proposalEventId = boundedString(value.proposalEventId);
  const actor = boundedString(value.actor);
  const createdAt = canonicalTimestamp(value.createdAt);
  const deliveryId = value.deliveryId === undefined ? undefined : boundedString(value.deliveryId);
  return { workspace, runId, proposalEventId, ...(deliveryId === undefined ? {} : { deliveryId }), actor, createdAt };
}

function parseProposalPayload(payload: unknown, input: ValidatedPromotionInput, reference: string): RecordEntryInput {
  if (!isPlainObject(payload) || [...Object.keys(payload)].some((key) => !PROPOSAL_FIELDS.has(key))) invalidProposal();
  let snapshot: unknown;
  try {
    const serialized = canonicalJson(payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) invalidProposal();
    snapshot = JSON.parse(serialized) as unknown;
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    invalidProposal();
  }
  if (findSecret(canonicalJson(snapshot))) securityRejected();

  try {
    const validated = validateRecordInput({
      workspace: input.workspace,
      kind: (snapshot as Record<string, unknown>).kind,
      status: 'candidate',
      title: (snapshot as Record<string, unknown>).title,
      body: (snapshot as Record<string, unknown>).body,
      summary: (snapshot as Record<string, unknown>).summary,
      scope: (snapshot as Record<string, unknown>).scope,
      provenance: { type: 'ledger_promotion', reference },
      trustLevel: 'untrusted',
      confidence: PROMOTION_CONFIDENCE,
      tags: (snapshot as Record<string, unknown>).tags,
      createdBy: input.actor,
      actor: input.actor,
    });
    return {
      workspace: validated.workspace,
      kind: validated.kind,
      status: 'candidate',
      title: validated.title,
      body: validated.body,
      summary: validated.summary,
      scope: validated.scope,
      provenance: validated.provenance,
      trustLevel: 'untrusted',
      confidence: PROMOTION_CONFIDENCE,
      tags: validated.tags,
      createdBy: input.actor,
      actor: input.actor,
    };
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'SECURITY_REJECTION') securityRejected();
    invalidProposal();
  }
}

function loadSource(database: SqliteDatabase, input: ValidatedPromotionInput): ProposalSource {
  const event = database.prepare(`
    SELECT e.sequence, e.event_type, e.payload_json
      FROM ledger_events AS e
      JOIN ledger_runs AS r ON r.run_id = e.run_id AND r.workspace = ?
     WHERE e.run_id = ? AND e.event_id = ?
  `).get<EventRow>(input.workspace, input.runId, input.proposalEventId);
  if (!event || event.event_type !== 'memory.proposed') notFound();

  let payload: unknown;
  try {
    payload = JSON.parse(event.payload_json) as unknown;
  } catch {
    invalidProposal();
  }

  let deliveryId: string | null = null;
  let intakeId: string | null = null;
  if (input.deliveryId !== undefined) {
    const delivery = database.prepare(`
      SELECT cd.delivery_id, cd.through_sequence, cd.intake_session_id
        FROM context_deliveries AS cd
        JOIN ledger_runs AS r ON r.run_id = cd.run_id AND r.workspace = ?
       WHERE cd.run_id = ? AND cd.delivery_id = ?
    `).get<DeliveryRow>(input.workspace, input.runId, input.deliveryId);
    if (!delivery) notFound();
    // Policy: a delivery relates to a proposal only when its ledger cursor includes that event.
    if (delivery.through_sequence < event.sequence) conflict();
    deliveryId = delivery.delivery_id;
    intakeId = delivery.intake_session_id;
  }
  return { sequence: event.sequence, payload, deliveryId, intakeId };
}

function buildReference(input: ValidatedPromotionInput, source: ProposalSource): string {
  const value: JsonObject = { eventId: input.proposalEventId, runId: input.runId };
  if (source.deliveryId !== null) value.deliveryId = source.deliveryId;
  if (source.intakeId !== null) value.intakeId = source.intakeId;
  const reference = canonicalJson(value);
  if (Buffer.byteLength(reference, 'utf8') > MAX_REFERENCE_BYTES) validation(INVALID_INPUT);
  return reference;
}

function sameOptional(left: string | null, right: string | null): boolean {
  return left === right;
}

function linkView(row: LinkRow): LedgerMemoryLinkView {
  return {
    linkId: row.link_id,
    runId: row.run_id,
    eventId: row.event_id,
    deliveryId: row.delivery_id,
    entryId: row.entry_id,
    createdAt: row.created_at,
    untrusted: true,
  };
}

function readExistingLink(database: SqliteDatabase, input: ValidatedPromotionInput, entryId: string): LinkRow | undefined {
  return database.prepare(`
    SELECT link_id, run_id, event_id, delivery_id, entry_id, created_at
      FROM ledger_memory_links
     WHERE run_id = ? AND event_id = ? AND entry_id = ?
  `).get<LinkRow>(input.runId, input.proposalEventId, entryId);
}

function contentIdentity(value: {
  kind: string;
  title: string;
  body: string;
  summary: string | null;
  scope: JsonObject;
  tags: string[];
}): string {
  return canonicalJson({
    kind: value.kind,
    title: value.title,
    body: value.body,
    summary: value.summary,
    scope: value.scope,
    tags: value.tags,
  });
}

function findSameContentEntry(database: SqliteDatabase, input: ValidatedPromotionInput, memoryInput: RecordEntryInput): EntryRecord | undefined {
  const rows = database.prepare(`
    SELECT id
      FROM entries AS e
      JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
     WHERE e.workspace = ? AND r.kind = ? AND r.title = ? AND r.body = ? AND r.summary IS ?
  `).all<{ id: string }>(
    input.workspace,
    memoryInput.kind,
    memoryInput.title,
    memoryInput.body,
    memoryInput.summary ?? null,
  );
  const expected = contentIdentity({
    kind: memoryInput.kind,
    title: memoryInput.title,
    body: memoryInput.body,
    summary: memoryInput.summary ?? null,
    scope: memoryInput.scope ?? {},
    tags: memoryInput.tags ?? [],
  });
  for (const row of rows) {
    const entry = readEntry(database, { workspace: input.workspace, entryId: row.id });
    if (contentIdentity(entry) === expected) return entry;
  }
  return undefined;
}

function promotePreparedInTransaction(database: SqliteDatabase, prepared: PreparedPromotion): LedgerPromotionResult {
  const current = loadSource(database, prepared.input);
  const currentReference = buildReference(prepared.input, current);
  const currentMemoryInput = parseProposalPayload(current.payload, prepared.input, currentReference);
  const currentHash = canonicalContentHash({
    kind: currentMemoryInput.kind,
    title: currentMemoryInput.title,
    body: currentMemoryInput.body,
    summary: currentMemoryInput.summary ?? null,
    scope: currentMemoryInput.scope ?? {},
    provenance: currentMemoryInput.provenance ?? {},
    tags: currentMemoryInput.tags ?? [],
  });
  if (currentHash !== prepared.contentHash || currentReference !== prepared.reference) conflict();

  const hashExisting = database.prepare(`
    SELECT id, status, trust_level
      FROM entries AS e
      JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
     WHERE e.workspace = ? AND r.content_hash = ?
  `).get<ExistingEntryRow>(prepared.input.workspace, prepared.contentHash);
  const contentExisting = hashExisting === undefined
    ? findSameContentEntry(database, prepared.input, prepared.memoryInput)
    : undefined;
  const existing = hashExisting ?? (contentExisting === undefined ? undefined : {
    id: contentExisting.id,
    status: contentExisting.status,
    trust_level: contentExisting.trustLevel,
  });
  if (existing && (existing.status !== 'candidate' || existing.trust_level !== 'untrusted')) conflict();

  const sourceLink = database.prepare(`
    SELECT link_id, run_id, event_id, delivery_id, entry_id, created_at
      FROM ledger_memory_links
     WHERE run_id = ? AND event_id = ?
  `).get<LinkRow>(prepared.input.runId, prepared.input.proposalEventId);

  if (sourceLink) {
    if (!existing || sourceLink.entry_id !== existing.id || !sameOptional(sourceLink.delivery_id, prepared.source.deliveryId)) conflict();
    const entry = readEntry(database, { workspace: prepared.input.workspace, entryId: existing.id });
    return { entry, link: linkView(sourceLink), untrusted: true };
  }

  if (existing) {
    const exactLink = readExistingLink(database, prepared.input, existing.id);
    if (exactLink && sameOptional(exactLink.delivery_id, prepared.source.deliveryId)) {
      const entry = readEntry(database, { workspace: prepared.input.workspace, entryId: existing.id });
      return { entry, link: linkView(exactLink), untrusted: true };
    }
    conflict();
  }

  const entry = recordEntryInTransaction(database, prepared.memoryInput, { now: prepared.input.createdAt });
  const linkId = randomUUID();
  database.prepare(`
    INSERT INTO ledger_memory_links (link_id, run_id, event_id, delivery_id, entry_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(linkId, prepared.input.runId, prepared.input.proposalEventId, prepared.source.deliveryId, entry.id, prepared.input.createdAt);
  const link = database.prepare(`
    SELECT link_id, run_id, event_id, delivery_id, entry_id, created_at
      FROM ledger_memory_links
     WHERE link_id = ?
  `).get<LinkRow>(linkId);
  if (!link) throw new KiokukoError('INTEGRITY_ERROR', 'Ledger promotion link could not be read back');
  return { entry, link: linkView(link), untrusted: true };
}

function preparePromotion(database: SqliteDatabase, value: unknown): PreparedPromotion {
  const input = parseInput(value);
  const source = loadSource(database, input);
  const reference = buildReference(input, source);
  const memoryInput = parseProposalPayload(source.payload, input, reference);
  const contentHash = canonicalContentHash({
    kind: memoryInput.kind,
    title: memoryInput.title,
    body: memoryInput.body,
    summary: memoryInput.summary ?? null,
    scope: memoryInput.scope ?? {},
    provenance: memoryInput.provenance ?? {},
    tags: memoryInput.tags ?? [],
  });
  return { input, memoryInput, contentHash, reference, source };
}

export function promoteLedgerProposal(database: SqliteDatabase, input: unknown): LedgerPromotionResult {
  const prepared = preparePromotion(database, input);
  return withImmediateTransaction(database, () => promotePreparedInTransaction(database, prepared));
}

export function promoteLedgerProposalInTransaction(database: SqliteDatabase, input: unknown): LedgerPromotionResult {
  const prepared = preparePromotion(database, input);
  return promotePreparedInTransaction(database, prepared);
}

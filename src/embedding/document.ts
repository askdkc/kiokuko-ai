import { createHash } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { KiokukoError } from '../errors.js';
import { canonicalJson, canonicalTagOrder, type JsonObject, type EntryKind } from '../serialization/validate.js';
import { findSecret } from '../memory/secrets.js';
import { validateApplicability, validateSignals } from '../memory/structured-memory.js';
import type {
  EmbeddingDocument,
  LocalEmbeddingProfileIdentity,
} from './types.js';

export const EMBEDDING_DOCUMENT_TEMPLATE_VERSION = 1 as const;
export const EMBEDDING_INPUT_CONTRACT = 'e5-query-passage-v1' as const;
export const MAX_EMBEDDING_DOCUMENT_BYTES = 32 * 1024;
export const BODY_TRUNCATION_MARKER = '[body truncated]' as const;

export interface EmbeddingDocumentInput {
  readonly kind: EntryKind;
  readonly title: string;
  readonly summary: string | null;
  readonly body: string;
  readonly tags: readonly string[];
  readonly scope: JsonObject;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const E5_DOCUMENT_PREFIX = 'passage: ' as const;

function invalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function normalizeText(value: string, field: string): string {
  const normalized = value.normalize('NFKC').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) invalid(`${field} contains a forbidden control character`);
  return normalized;
}

function normalizedTagList(tags: readonly string[]): string[] {
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.trim().length === 0 || tag.length > 200) invalid('Embedding document tags are invalid');
  }
  return canonicalTagOrder(tags.map((tag) => normalizeText(tag, 'tag')));
}

function structuredScope(scope: JsonObject): { applicability: JsonObject; signals: JsonObject } {
  const candidate = scope as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) return { applicability: {}, signals: {} };
  const applicability = candidate.applicability === undefined ? {} : validateApplicability(candidate.applicability);
  const signals = candidate.signals === undefined ? {} : validateSignals(candidate.signals);
  return {
    applicability: applicability as unknown as JsonObject,
    signals: signals as unknown as JsonObject,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const bytes = encoder.encode(value);
  let end = Math.min(bytes.byteLength, maxBytes);
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

function documentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function buildDocument(
  input: EmbeddingDocumentInput,
  templateHeader: 'kiokuko-memory-v1' | 'kiokuko-memory-v2',
  maximumBytes: number,
): EmbeddingDocument {
  if (input.kind !== 'fact' && input.kind !== 'decision' && input.kind !== 'lesson' && input.kind !== 'preference' && input.kind !== 'reference') {
    invalid('Embedding document kind is invalid');
  }
  const title = normalizeText(input.title, 'title').trim();
  const summary = input.summary === null ? '' : normalizeText(input.summary, 'summary').trim();
  const body = normalizeText(input.body, 'body');
  const tags = normalizedTagList(input.tags);
  const { applicability, signals } = structuredScope(input.scope);
  const metadataText = [
    templateHeader,
    `kind: ${input.kind}`,
    `title: ${title}`,
    `summary: ${summary}`,
    'tags:',
    ...tags.map((tag) => `- ${tag}`),
    'applicability:',
    canonicalJson(applicability),
    'signals:',
    canonicalJson(signals),
    'body:',
  ].join('\n') + '\n';
  const metadataBytes = encoder.encode(metadataText);
  if (metadataBytes.byteLength >= maximumBytes) {
    invalid('Embedding document metadata exceeds the byte limit');
  }

  const bodyBytes = encoder.encode(body);
  let text = metadataText + body;
  let truncated = false;
  if (metadataBytes.byteLength + bodyBytes.byteLength > maximumBytes) {
    const marker = `\n${BODY_TRUNCATION_MARKER}`;
    const markerBytes = encoder.encode(marker);
    const available = maximumBytes - metadataBytes.byteLength - markerBytes.byteLength;
    if (available < 0) invalid('Embedding document metadata exceeds the byte limit');
    text = metadataText + truncateUtf8(body, available) + marker;
    truncated = true;
  }

  const bytes = encoder.encode(text);
  const secretFinding = findSecret(text);
  if (secretFinding !== undefined) {
    throw new KiokukoError('SECURITY_REJECTION', 'Embedding document resembles a secret and was not sent');
  }
  return Object.freeze({ text, bytes, documentHash: documentHash(bytes), truncated });
}

export function buildEmbeddingDocument(input: EmbeddingDocumentInput): EmbeddingDocument {
  return buildDocument(input, 'kiokuko-memory-v1', MAX_EMBEDDING_DOCUMENT_BYTES);
}

/** Build the provider-neutral v1 memory representation for the local E5 model. */
export function buildCanonicalEmbeddingDocument(input: EmbeddingDocumentInput): EmbeddingDocument {
  return buildDocument(
    input,
    'kiokuko-memory-v1',
    MAX_EMBEDDING_DOCUMENT_BYTES - encoder.encode(E5_DOCUMENT_PREFIX).byteLength,
  );
}

export function renderEmbeddingProviderInput(canonicalText: string, prefix = E5_DOCUMENT_PREFIX): string {
  if (typeof canonicalText !== 'string' || canonicalText.length === 0 || prefix !== E5_DOCUMENT_PREFIX) {
    invalid('Embedding provider document input is invalid');
  }
  const providerInput = `${prefix}${canonicalText}`;
  if (encoder.encode(providerInput).byteLength > MAX_EMBEDDING_DOCUMENT_BYTES) {
    invalid('Embedding provider document input exceeds the byte limit');
  }
  if (findSecret(providerInput) !== undefined) {
    throw new KiokukoError('SECURITY_REJECTION', 'Embedding provider document input resembles a secret and was not sent');
  }
  return providerInput;
}

export type EmbeddingProfileIdentityLike = LocalEmbeddingProfileIdentity;

/** Select the canonical document representation for the active embedding profile. */
export function buildEmbeddingDocumentForProfile(
  input: EmbeddingDocumentInput,
  profile: EmbeddingProfileIdentityLike,
): EmbeddingDocument {
  if (profile.providerKind !== 'local-transformers') invalid('Embedding profile provider is invalid');
  return buildCanonicalEmbeddingDocument(input);
}

/** Render only the provider input required by the selected profile contract. */
export function renderEmbeddingDocumentInputForProfile(
  document: EmbeddingDocument,
  profile: EmbeddingProfileIdentityLike,
): string {
  if (profile.providerKind !== 'local-transformers') invalid('Embedding profile provider is invalid');
  return renderEmbeddingProviderInput(document.text, profile.documentPrefix);
}

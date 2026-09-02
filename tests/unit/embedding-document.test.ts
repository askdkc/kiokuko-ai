import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCanonicalEmbeddingDocument,
  buildEmbeddingDocument,
  buildEmbeddingDocumentForProfile,
  MAX_EMBEDDING_DOCUMENT_BYTES,
  renderEmbeddingDocumentInputForProfile,
  renderEmbeddingProviderInput,
} from '../../src/embedding/document.js';
import { createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';

const base = {
  kind: 'lesson' as const,
  title: '  Use deterministic projections  ',
  summary: 'Keep canonical data authoritative.',
  body: 'A body that explains the projection.',
  tags: ['semantic', 'sqlite', 'semantic'],
  scope: {
    schemaVersion: 1,
    visibility: 'project',
    applicability: {
      frameworks: [{ name: 'Svelte', version: '5' }, { name: 'Node.js' }],
      languages: ['TypeScript'],
    },
    signals: { paths: ['src/embedding/vector.ts'], errors: ['SQLITE_BUSY'] },
  },
};

test('builds the same canonical document regardless of tag and metadata order', () => {
  const first = buildEmbeddingDocument(base);
  const second = buildEmbeddingDocument({
    ...base,
    tags: ['sqlite', 'semantic'],
    scope: {
      schemaVersion: 1,
      visibility: 'project',
      signals: { errors: ['SQLITE_BUSY'], paths: ['src/embedding/vector.ts'] },
      applicability: {
        languages: ['TypeScript'],
        frameworks: [{ name: 'Node.js' }, { name: 'Svelte', version: '5' }],
      },
    },
  });

  assert.equal(first.text, second.text);
  assert.equal(first.documentHash, second.documentHash);
  assert.equal(first.truncated, false);
  assert.match(first.text, /^kiokuko-memory-v1\nkind: lesson\n/u);
  assert.match(first.text, /tags:\n- semantic\n- sqlite\n/u);
  assert.equal(first.text.includes('visibility'), false);
  assert.equal(first.text.includes('visibility'), false);
  assert.equal(first.text.includes('src\/embedding\/vector.ts'), true);
});

test('truncates only the body at the deterministic UTF-8 byte boundary', () => {
  const document = buildEmbeddingDocument({ ...base, body: '日本語'.repeat(20_000) });

  assert.equal(document.truncated, true);
  assert.ok(document.bytes.byteLength <= MAX_EMBEDDING_DOCUMENT_BYTES);
  assert.match(document.text, /\n\[body truncated\]$/u);
  assert.match(document.text, /title: Use deterministic projections/u);
});

test('rejects control characters and secret-shaped documents before sending', () => {
  assert.throws(() => buildEmbeddingDocument({ ...base, body: 'bad\u0000body' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => buildEmbeddingDocument({ ...base, body: 'api_key = sk-abcdefghijklmnop' }), { code: 'SECURITY_REJECTION' });
});

test('selects the local profile document contract and bounds the rendered passage input', () => {
  const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
  const canonical = buildCanonicalEmbeddingDocument({ ...base, body: 'body '.repeat(20_000) });
  const selected = buildEmbeddingDocumentForProfile(base, profile.identity);
  const providerInput = renderEmbeddingDocumentInputForProfile(canonical, profile.identity);

  assert.equal(selected.text.startsWith('kiokuko-memory-v1\n'), true);
  assert.equal(canonical.text.startsWith('kiokuko-memory-v1\n'), true);
  assert.equal(providerInput, renderEmbeddingProviderInput(canonical.text, profile.identity.documentPrefix));
  assert.equal(providerInput.startsWith('passage: kiokuko-memory-v1\n'), true);
  assert.ok(new TextEncoder().encode(providerInput).byteLength <= MAX_EMBEDDING_DOCUMENT_BYTES);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCapabilityCatalogBinding,
  bindCapabilityCatalog,
  capabilityCatalogDigest,
} from '../../src/akinator/capability-binding.js';
import { normalizeCapabilityCatalog } from '../../src/akinator/capabilities.js';

test('capability catalog binding hashes the normalized descriptor set without depending on order or duplicates', () => {
  const first = [
    { kind: 'mcp_tool', name: 'repository_search', description: 'Search repository code' },
    { kind: 'skill', name: 'memory-reasoning', description: 'Verify remembered claims' },
  ];
  const reordered = [...first].reverse();
  assert.equal(capabilityCatalogDigest(first), 'dcadb89b1e8f1f31f0c6fb76bf6e49e2c95f21f0d32e5ba6418ad784a30958a9');
  assert.equal(capabilityCatalogDigest(first), capabilityCatalogDigest(reordered));
  assert.equal(capabilityCatalogDigest(first), capabilityCatalogDigest([...first, first[0], first[1]]));
  assert.notEqual(capabilityCatalogDigest(undefined), capabilityCatalogDigest([]));
  assert.notEqual(
    capabilityCatalogDigest(undefined),
    capabilityCatalogDigest([{ kind: 'invalid', name: 'discarded' }]),
  );
});

test('capability catalog binding changes for every effective descriptor change', () => {
  const catalog = [
    { kind: 'mcp_tool', name: 'repository_search', description: 'Search repository code' },
    { kind: 'skill', name: 'memory-reasoning', description: 'Verify remembered claims' },
  ];
  const digest = capabilityCatalogDigest(catalog);
  const variants = [
    catalog.slice(1),
    [...catalog, { kind: 'skill', name: 'new-skill' }],
    [{ ...catalog[0], name: 'repository_query' }, catalog[1]],
    [{ ...catalog[0], kind: 'skill' }, catalog[1]],
    [{ ...catalog[0], description: 'Query repository code' }, catalog[1]],
  ];
  for (const variant of variants) assert.notEqual(capabilityCatalogDigest(variant), digest);
});

test('a malformed catalog item does not erase separately valid descriptors', () => {
  const valid = { kind: 'skill', name: 'kiokuko-soul' };
  const mixed = [valid, { kind: 'invalid', name: 'broken-marketplace-entry' }];
  const normalized = normalizeCapabilityCatalog(mixed);
  assert.equal(normalized.availability, 'unknown');
  assert.deepEqual(normalized.skills, [valid]);
  assert.notEqual(capabilityCatalogDigest(mixed), capabilityCatalogDigest([]));
  assert.notEqual(capabilityCatalogDigest(mixed), capabilityCatalogDigest([valid]));
});

test('capability catalog binding accepts only the catalog bound at run open', () => {
  const catalog = [{ kind: 'skill', name: 'memory-reasoning' }];
  const metadata = bindCapabilityCatalog({ source: 'test' }, catalog);
  assert.doesNotThrow(() => assertCapabilityCatalogBinding(metadata, catalog));
  assert.doesNotThrow(() => assertCapabilityCatalogBinding(metadata, [...catalog, ...catalog]));
  assert.throws(
    () => assertCapabilityCatalogBinding(metadata, []),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && !error.message.includes(capabilityCatalogDigest(catalog)),
  );
  assert.throws(
    () => assertCapabilityCatalogBinding({}, catalog),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR',
  );
  assert.throws(
    () => bindCapabilityCatalog(metadata, catalog),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
  );
});

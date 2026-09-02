import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePortability } from '../../src/memory/portability.js';

function entry(overrides: Partial<Parameters<typeof analyzePortability>[0]> = {}): Parameters<typeof analyzePortability>[0] {
  return {
    workspace: 'project:portable-source',
    title: 'Portable guidance',
    summary: null,
    body: 'Use a reusable transaction boundary.',
    tags: ['typescript'],
    scope: {},
    provenance: {},
    ...overrides,
  };
}

test('rejects private paths in tags, bodies, and structured path signals', () => {
  for (const candidate of [
    entry({ tags: ['/Users/alice/private-client'] }),
    entry({ tags: ['docs/private-runbook.md'] }),
    entry({ tags: ['.github/workflows/internal.yml'] }),
    entry({ body: 'Run scripts/private-deploy.sh before release.' }),
    entry({ body: 'Read ./docs/internal.md first.' }),
    entry({ body: String.raw`Run .\scripts\deploy.ps1 before release.` }),
    entry({ scope: { signals: { paths: ['docs/private-signal.md'] } } }),
  ]) {
    const result = analyzePortability(candidate);
    assert.equal(result.portable, false);
    assert.ok(result.reasons.includes('project-relative-path') || result.reasons.includes('absolute-path'));
  }
});

test('keeps package names and slash-free prose portable without mutating input', () => {
  const candidate = entry({
    title: 'Documentation scripts',
    body: 'documentation scripts remain general guidance',
    tags: ['@scope/package'],
  });
  const snapshot = structuredClone(candidate);
  const first = analyzePortability(candidate);
  const second = analyzePortability(candidate);
  assert.deepEqual(first, { portable: true, projectSpecific: false, reasons: [] });
  assert.deepEqual(second, first);
  assert.deepEqual(candidate, snapshot);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { readEntry, recordEntry } from '../../src/memory/entries.js';
import { checkpointScopedMemory, recallScopedMemory } from '../../src/memory/scoped-memory.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { GLOBAL_WORKSPACE, resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { federatedEntries, retrieveFederatedMemory } from '../../src/memory/federated-retrieval.js';
import { rankedEntryHits, recallEntries } from '../../src/memory/retrieval.js';

async function repository(prefix: string, manifest: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-federated-${prefix}-`));
  execFileSync('git', ['init', '-q', root]);
  if (Object.keys(manifest).length > 0) await writeFile(path.join(root, manifest.file as string), JSON.stringify(manifest.value));
  return root;
}

test('retrieves applicable project-owned memory through ecosystem scope without leaking local paths', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-federated-db-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const firstRoot = await repository('laravel-a', { file: 'composer.json', value: { require: { 'laravel/framework': '^13.0' } } });
  const secondRoot = await repository('laravel-b', { file: 'composer.json', value: { require: { 'laravel/framework': '^13.0' } } });
  const svelteRoot = await repository('svelte', { file: 'package.json', value: { dependencies: { svelte: '^5.0', typescript: '^5.0' } } });
  const incompatibleRoot = await repository('laravel-11', { file: 'composer.json', value: { require: { 'laravel/framework': '^11.0' } } });
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const first = await resolveProjectWorkspace(database, firstRoot);
    const second = await resolveProjectWorkspace(database, secondRoot);
    assert.ok(first); assert.ok(second);
    recordEntry(database, {
      workspace: first.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Laravel migration rollback pattern',
      body: 'When a Laravel migration fails, inspect the transaction and retry after verifying the schema.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: first.repositoryId,
        memoryClass: 'troubleshooting',
        applicability: { frameworks: [{ name: 'Laravel', version: '>=12 <14' }] },
        signals: { errors: ['migration failure'] },
      }),
      tags: ['Laravel', 'migration'],
    });
    recordEntry(database, {
      workspace: first.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Laravel private path only',
      body: 'Only change src/private.ts in this project.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: first.repositoryId,
        applicability: { frameworks: [{ name: 'Laravel', version: '>=12 <14' }] },
        signals: { paths: ['src/private.ts'] },
      }),
    });
    const initial = await recallScopedMemory(database, { cwd: secondRoot, query: 'Laravel migration' });
    assert.equal(initial.ecosystem?.items.some((item) => item.title === 'Laravel migration rollback pattern'), true);
    const shared = initial.ecosystem?.items.find((item) => item.title === 'Laravel migration rollback pattern');
    assert.equal(shared?.origin, 'ecosystem');
    assert.equal(shared?.sourceWorkspace, first.workspace);
    assert.equal(initial.ecosystem?.items.some((item) => item.title === 'Laravel private path only'), false);

    recordEntry(database, {
      workspace: first.workspace,
      kind: 'reference',
      status: 'candidate',
      title: 'Ordinary memory with an external skill tag',
      body: 'Portable Laravel migration guidance that is not managed by the external skill store.',
      scope: buildStructuredScope({ visibility: 'project', retrievalScope: 'ecosystem', applicability: { frameworks: [{ name: 'Laravel', version: '>=12 <14' }] }, signals: { packages: ['laravel/framework'] } }),
      tags: ['external:skill', 'Laravel'],
    });
    const taggedOrdinary = await recallScopedMemory(database, { cwd: secondRoot, query: 'Laravel migration laravel/framework' });
    assert.equal(taggedOrdinary.ecosystem?.items.some((item) => item.title === 'Ordinary memory with an external skill tag'), true);

    for (let index = 0; index < 4; index += 1) {
      recordEntry(database, {
        workspace: first.workspace,
        kind: 'lesson',
        status: 'verified',
        title: `Laravel migration reusable note ${index}`,
        body: `For Laravel migration work, verify the transaction boundary before applying change ${index}.`,
        scope: buildStructuredScope({
          visibility: 'project',
          retrievalScope: 'ecosystem',
          repositoryId: first.repositoryId,
          applicability: { frameworks: [{ name: 'Laravel', version: '>=12 <14' }] },
        }),
      });
    }

    const fromLaravel = await recallScopedMemory(database, { cwd: secondRoot, query: 'Laravel migration' });
    assert.equal(fromLaravel.ecosystem?.items.filter((item) => item.sourceWorkspace === first.workspace).length, 3);

    const fromSvelte = await recallScopedMemory(database, { cwd: svelteRoot, query: 'Laravel migration' });
    assert.equal(fromSvelte.ecosystem, null);

    recordEntry(database, {
      workspace: first.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Laravel SQLSTATE recovery',
      body: 'Retry the Laravel migration only after diagnosing sqlstate[23505].',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: first.repositoryId,
        applicability: { frameworks: [{ name: 'Laravel', version: '>=12 <14' }], languages: ['PHP'] },
        signals: { errors: ['sqlstate[23505]'] },
      }),
    });
    const signalOnlyFromSvelte = await recallScopedMemory(database, { cwd: svelteRoot, query: 'sqlstate[23505]' });
    assert.equal(signalOnlyFromSvelte.ecosystem?.items.some((item) => item.title === 'Laravel SQLSTATE recovery') ?? false, false);

    const fromIncompatible = await recallScopedMemory(database, { cwd: incompatibleRoot, query: 'Laravel migration' });
    assert.equal(fromIncompatible.ecosystem, null);

    recordEntry(database, {
      workspace: second.workspace,
      kind: 'decision',
      status: 'candidate',
      title: 'Laravel migration local decision',
      body: 'Use the local migration transaction policy.',
      tags: ['Laravel'],
    });
    const prioritized = await recallScopedMemory(database, { cwd: secondRoot, query: 'Laravel migration' });
    assert.equal(prioritized.combined?.items[0]?.origin, 'project');
  } finally {
    database.close();
  }
});

test('preserves ecosystem relevance order when composing auto recall', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-federated-ranking-db-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const sourceRoot = await repository('ranking-source', { file: 'composer.json', value: { require: { 'laravel/framework': '^13.0' } } });
  const targetRoot = await repository('ranking-target', { file: 'composer.json', value: { require: { 'laravel/framework': '^13.0' } } });
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const source = await resolveProjectWorkspace(database, sourceRoot);
    assert.ok(source);
    await resolveProjectWorkspace(database, targetRoot);
    recordEntry(database, {
      workspace: source.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Laravel migration exact guidance',
      body: 'Verify Laravel migration transactions before retrying the migration.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: source.repositoryId,
        applicability: { frameworks: [{ name: 'Laravel', version: '>=12 <14' }] },
      }),
    }, { idFactory: () => 'z-high-relevance' });
    recordEntry(database, {
      workspace: source.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Generic PHP note',
      body: 'Review PHP runtime behavior before changing shared code.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: source.repositoryId,
        applicability: { languages: ['PHP'] },
      }),
    }, { idFactory: () => 'a-low-relevance' });

    const recalled = await recallScopedMemory(database, { cwd: targetRoot, query: 'migration', limit: 10 });
    assert.deepEqual(recalled.ecosystem?.items.map((item) => item.id), ['z-high-relevance', 'a-low-relevance']);
    assert.deepEqual(recalled.combined?.items.map((item) => item.id), ['z-high-relevance', 'a-low-relevance']);
  } finally {
    database.close();
  }
});

test('keeps path-bearing tags project-local for automatic and explicit ecosystem memory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-federated-path-tags-db-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const sourceRoot = await repository('path-tags-source', { file: 'package.json', value: { devDependencies: { typescript: '^5.9' } } });
  const targetRoot = await repository('path-tags-target', { file: 'package.json', value: { devDependencies: { typescript: '^5.9' } } });
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const source = await resolveProjectWorkspace(database, sourceRoot);
    assert.ok(source);
    await resolveProjectWorkspace(database, targetRoot);
    const explicit = recordEntry(database, {
      workspace: source.workspace,
      kind: 'lesson',
      title: 'Private runbook boundary',
      body: 'Keep this guidance in its source project.',
      tags: ['docs/private-runbook.md'],
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: source.repositoryId,
        applicability: { languages: ['TypeScript'] },
      }),
    }, { idFactory: () => 'entry-path-tag-explicit' });
    const projectOnly = recordEntry(database, {
      workspace: source.workspace,
      kind: 'lesson',
      title: 'Explicit project-only boundary',
      body: 'This portable-looking guidance is deliberately confined to its source project.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'project-only',
        repositoryId: source.repositoryId,
        applicability: { languages: ['TypeScript'] },
      }),
    }, { idFactory: () => 'entry-explicit-project-only' });
    const checkpoint = await checkpointScopedMemory(database, {
      cwd: sourceRoot,
      memories: [{
        kind: 'lesson',
        title: 'Automatic private workflow boundary',
        body: 'Keep automatic routing local.',
        tags: ['.github/workflows/internal.yml'],
        applicability: { languages: ['TypeScript'] },
      }],
    });
    const automatic = readEntry(database, { workspace: source.workspace, entryId: checkpoint.entries[0]!.id });
    assert.equal((automatic.scope as Record<string, unknown>).retrievalScope, undefined);

    const crossProject = await recallScopedMemory(database, { cwd: targetRoot, query: 'private workflow boundary', limit: 20 });
    assert.equal(crossProject.ecosystem?.items.some((item) => item.id === explicit.id) ?? false, false);
    assert.equal(crossProject.ecosystem?.items.some((item) => item.id === automatic.id) ?? false, false);
    assert.equal(crossProject.ecosystem?.items.some((item) => item.id === projectOnly.id) ?? false, false);

    const sameProject = await recallScopedMemory(database, { cwd: sourceRoot, query: 'private workflow boundary', scope: 'project', limit: 20 });
    assert.equal(sameProject.project?.memory.items.some((item) => item.id === explicit.id), true);
    assert.equal(sameProject.project?.memory.items.some((item) => item.id === automatic.id), true);
    assert.equal(sameProject.project?.memory.items.some((item) => item.id === projectOnly.id), true);
  } finally {
    database.close();
  }
});

test('requires an explicit retrieval scope for ecosystem and global federation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-federated-explicit-scope-db-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const sourceRoot = await repository('explicit-scope-source', { file: 'package.json', value: { devDependencies: { typescript: '^5.9' } } });
  const targetRoot = await repository('explicit-scope-target', { file: 'package.json', value: { devDependencies: { typescript: '^5.9' } } });
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const source = await resolveProjectWorkspace(database, sourceRoot);
    const target = await resolveProjectWorkspace(database, targetRoot);
    assert.ok(source); assert.ok(target);
    const sharedMetadata = {
      applicability: { languages: ['TypeScript'] },
      signals: { packages: ['typescript'] },
    };
    const projectOnly = recordEntry(database, {
      workspace: source.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Implicit scope federation sentinel',
      body: 'Applicability metadata alone must not make this memory cross a project boundary.',
      scope: buildStructuredScope({
        visibility: 'project',
        repositoryId: source.repositoryId,
        ...sharedMetadata,
      }),
    }, { idFactory: () => 'entry-implicit-project-only' });
    const ecosystem = recordEntry(database, {
      workspace: source.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Explicit ecosystem federation sentinel',
      body: 'An explicit ecosystem scope permits compatible cross-project retrieval.',
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: source.repositoryId,
        ...sharedMetadata,
      }),
    }, { idFactory: () => 'entry-explicit-ecosystem' });
    const implicitGlobal = recordEntry(database, {
      workspace: GLOBAL_WORKSPACE,
      kind: 'lesson',
      status: 'verified',
      title: 'Implicit global federation sentinel',
      body: 'Global visibility without an explicit retrieval scope is not federated.',
      scope: buildStructuredScope({
        visibility: 'global',
        ...sharedMetadata,
      }),
    }, { idFactory: () => 'entry-implicit-global' });
    const explicitGlobal = recordEntry(database, {
      workspace: GLOBAL_WORKSPACE,
      kind: 'lesson',
      status: 'candidate',
      title: 'Explicit global federation sentinel',
      body: 'An explicit global retrieval scope permits global federation.',
      scope: buildStructuredScope({
        visibility: 'global',
        retrievalScope: 'global',
        ...sharedMetadata,
      }),
    }, { idFactory: () => 'entry-explicit-global' });

    const crossProject = await retrieveFederatedMemory(database, {
      project: target,
      scope: 'auto',
      query: 'federation sentinel typescript',
      limit: 20,
    });
    assert.equal(crossProject.ecosystem?.items.some((item) => item.id === projectOnly.id) ?? false, false);
    assert.equal(crossProject.ecosystem?.items.some((item) => item.id === ecosystem.id) ?? false, true);
    assert.equal(crossProject.global?.items.some((item) => item.id === implicitGlobal.id) ?? false, false);
    assert.equal(crossProject.global?.items.some((item) => item.id === explicitGlobal.id) ?? false, true);
    assert.equal(crossProject.combined?.items.some((item) => item.id === projectOnly.id) ?? false, false);
    assert.equal(crossProject.combined?.items.some((item) => item.id === implicitGlobal.id) ?? false, false);

    const brokerCandidates = await federatedEntries(database, {
      project: target,
      query: 'federation sentinel typescript',
      limit: 20,
    });
    assert.equal(brokerCandidates.some((item) => item.entry.id === projectOnly.id), false);
    assert.equal(brokerCandidates.some((item) => item.entry.id === ecosystem.id && item.origin === 'ecosystem'), true);
    assert.equal(brokerCandidates.some((item) => item.entry.id === implicitGlobal.id), false);
    assert.equal(brokerCandidates.some((item) => item.entry.id === explicitGlobal.id && item.origin === 'global'), true);

    const globalOnly = await retrieveFederatedMemory(database, {
      scope: 'global',
      query: 'global federation sentinel',
      limit: 1,
    });
    assert.equal(globalOnly.global?.items.some((item) => item.id === implicitGlobal.id) ?? false, false);
    assert.equal(globalOnly.global?.items.some((item) => item.id === explicitGlobal.id) ?? false, true);

    const sameProject = await retrieveFederatedMemory(database, {
      project: source,
      scope: 'project',
      query: 'implicit scope federation sentinel',
      limit: 20,
    });
    assert.equal(sameProject.project?.memory.items.some((item) => item.id === projectOnly.id), true);
  } finally {
    database.close();
  }
});

test('preserves hybrid relevance and lane reasons before limits without status or origin bonuses', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-federated-hybrid-rank-db-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const root = await repository('hybrid-rank', { file: 'package.json', value: { devDependencies: { typescript: '^5.9' } } });
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const project = await resolveProjectWorkspace(database, root);
    assert.ok(project);
    recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'verified',
      title: 'Weak lexical path mention',
      body: 'This prose happens to mention src/exact.ts without a structured signal.',
    }, { idFactory: () => 'a-weak-verified' });
    recordEntry(database, {
      workspace: project.workspace,
      kind: 'lesson',
      status: 'candidate',
      title: 'Exact structured path guidance',
      body: 'Use the exact structured path guidance.',
      scope: buildStructuredScope({ visibility: 'project', signals: { paths: ['src/exact.ts'] } }),
    }, { idFactory: () => 'z-exact-candidate' });

    const first = rankedEntryHits(database, { workspace: project.workspace, query: 'src/exact.ts', limit: 10 });
    const second = rankedEntryHits(database, { workspace: project.workspace, query: 'src/exact.ts', limit: 10 });
    assert.deepEqual(second, first);
    assert.equal(first.hits[0]?.entryId, 'z-exact-candidate');
    assert.ok(first.hits[0]?.reasons.includes('exact_signal_match'));
    assert.equal(recallEntries(database, { workspace: project.workspace, query: 'src/exact.ts', limit: 1 }).items[0]?.id, 'z-exact-candidate');

    const federated = await federatedEntries(database, { project, query: 'src/exact.ts', limit: 10 });
    assert.deepEqual(federated.filter((item) => item.origin === 'project').map((item) => item.entry.id), first.hits.map((hit) => hit.entryId));
    assert.equal(federated[0]?.score, first.hits[0]?.retrievalScore);
    assert.ok(federated[0]?.selectionReasons.includes('exact_signal_match'));
    assert.equal(federated[0]?.selectionReasons.includes('verified'), false);
    assert.equal(federated[0]?.selectionReasons.includes('candidate'), false);

    const scoped = await recallScopedMemory(database, { cwd: root, query: 'src/exact.ts', limit: 1 });
    assert.equal(scoped.combined?.items[0]?.id, 'z-exact-candidate');
    assert.ok(scoped.combined?.items[0]?.selectionReasons.includes('exact_signal_match'));
  } finally {
    database.close();
  }
});

test('rejects invalid federated recall bounds instead of replacing zero with defaults', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-federated-bounds-db-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    for (const limit of [0, -1, 1.5, Number.NaN, 101]) {
      await assert.rejects(
        retrieveFederatedMemory(database, { scope: 'global', query: 'boundary', limit }),
        /Federated retrieval limit is invalid/u,
      );
    }
    for (const maxChars of [0, -1, 1.5, Number.NaN, 100_001]) {
      await assert.rejects(
        retrieveFederatedMemory(database, { scope: 'global', query: 'boundary', maxChars }),
        /Federated retrieval limit is invalid/u,
      );
    }
  } finally {
    database.close();
  }
});

test('counts Unicode code points across local and ecosystem recall without splitting astral characters', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-federated-unicode-db-'));
  const databasePath = path.join(directory, 'kiokuko-ai.sqlite');
  const sourceRoot = await repository('unicode-source', { file: 'package.json', value: { devDependencies: { typescript: '^5.9' } } });
  const targetRoot = await repository('unicode-target', { file: 'package.json', value: { devDependencies: { typescript: '^5.9' } } });
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const codePoints = (value: string): number => Array.from(value).length;
  try {
    const source = await resolveProjectWorkspace(database, sourceRoot);
    const target = await resolveProjectWorkspace(database, targetRoot);
    assert.ok(source); assert.ok(target);
    const localTitle = '🧠 local astral';
    const localBody = '🙂🚀終🧪';
    recordEntry(database, {
      workspace: target.workspace,
      kind: 'lesson',
      status: 'verified',
      title: localTitle,
      body: localBody,
    }, { idFactory: () => 'entry-unicode-local' });
    const localBudget = codePoints(localTitle) + 1 + 2;
    const local = recallEntries(database, {
      workspace: target.workspace,
      query: 'local astral',
      limit: 1,
      maxChars: localBudget,
    });
    assert.equal(local.items[0]?.snippet, '🙂🚀');
    assert.equal(local.characterCount, localBudget);
    assert.equal(local.truncated, true);

    const combined = await retrieveFederatedMemory(database, {
      project: target,
      scope: 'auto',
      query: 'local astral',
      limit: 1,
      maxChars: localBudget,
    });
    assert.equal(combined.combined?.items[0]?.snippet, '🙂🚀');
    assert.equal(combined.combined?.characterCount, localBudget);

    const ecosystemTitle = '🧠 ecosystem astral';
    const ecosystemBody = '🙂🚀終🧪';
    recordEntry(database, {
      workspace: source.workspace,
      kind: 'lesson',
      status: 'verified',
      title: ecosystemTitle,
      body: ecosystemBody,
      scope: buildStructuredScope({
        visibility: 'project',
        retrievalScope: 'ecosystem',
        repositoryId: source.repositoryId,
        applicability: { languages: ['TypeScript'] },
      }),
    }, { idFactory: () => 'entry-unicode-ecosystem' });
    const ecosystemBudget = codePoints(ecosystemTitle) + 1 + 2;
    const ecosystem = await retrieveFederatedMemory(database, {
      project: target,
      scope: 'ecosystem',
      query: 'ecosystem astral',
      limit: 1,
      maxChars: ecosystemBudget,
    });
    assert.equal(ecosystem.ecosystem?.items[0]?.snippet, '🙂🚀');
    assert.equal(ecosystem.ecosystem?.characterCount, ecosystemBudget);
    assert.equal(ecosystem.ecosystem?.truncated, true);
  } finally {
    database.close();
  }
});

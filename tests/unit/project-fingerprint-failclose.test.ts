import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import type { ResolvedProjectWorkspace } from '../../src/memory/workspaces.js';
import {
  assertProjectManifestSnapshotBinding,
  bindProjectManifestSnapshot,
  captureProjectManifestSnapshot,
  computeProjectFingerprint,
  PROJECT_MANIFEST_BINDING_METADATA_KEY,
  resolveProjectFingerprint,
} from '../../src/repository/project-fingerprint.js';

const migrationsDirectory = path.resolve(import.meta.dirname, '../../migrations');

function project(repositoryRoot: string): ResolvedProjectWorkspace {
  return {
    repositoryRoot,
    repositoryId: 'repo_fingerprint_failclose',
    workspace: 'project:fingerprint-failclose',
    source: 'local-path',
  };
}

function registerProject(database: ReturnType<typeof openConnection>, value: ResolvedProjectWorkspace): void {
  database.prepare(`
    INSERT INTO repositories (
      repository_id, workspace, display_name, remote_fingerprint,
      binding_schema_version, agent_template_version, created_at, last_used_at
    ) VALUES (?, ?, 'Fingerprint fixture', NULL, 1, 0, ?, ?)
  `).run(value.repositoryId, value.workspace, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');
}

function isIntegrityError(error: unknown): boolean {
  return error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR';
}

function resolveLiveFingerprint(
  database: ReturnType<typeof openConnection>,
  resolved: ResolvedProjectWorkspace,
) {
  return resolveProjectFingerprint(database, resolved, captureProjectManifestSnapshot(resolved));
}

test('matching-digest corrupt fingerprint cache rows fail closed and remain unchanged', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-cache-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    const resolved = project(root);
    registerProject(database, resolved);
    const current = resolveLiveFingerprint(database, resolved);
    const corruptRows = [
      '{',
      JSON.stringify({ ...current, unexpected: true }),
      JSON.stringify({ ...current, repositoryId: 'repo_wrong' }),
      JSON.stringify({ ...current, manifestDigest: 'f'.repeat(64) }),
      JSON.stringify({ ...current, frameworks: [{ name: 'Svelte', executable: true }] }),
      JSON.stringify({ ...current, languages: Array.from({ length: 1_001 }, (_, index) => `Language-${index}`) }),
      JSON.stringify({ ...current, languages: ['COBOL'] }),
    ];

    for (const fingerprintJson of corruptRows) {
      database.prepare('UPDATE repository_fingerprints SET fingerprint_json = ?, updated_at = ? WHERE repository_id = ?')
        .run(fingerprintJson, '2026-08-25T01:02:03.000Z', resolved.repositoryId);
      const before = database.prepare('SELECT * FROM repository_fingerprints WHERE repository_id = ?').get(resolved.repositoryId);

      assert.throws(() => resolveLiveFingerprint(database, resolved), isIntegrityError);
      assert.deepEqual(database.prepare('SELECT * FROM repository_fingerprints WHERE repository_id = ?').get(resolved.repositoryId), before);
    }

    database.prepare('UPDATE repository_fingerprints SET manifest_digest = ? WHERE repository_id = ?')
      .run('not-a-digest', resolved.repositoryId);
    const before = database.prepare('SELECT * FROM repository_fingerprints WHERE repository_id = ?').get(resolved.repositoryId);
    assert.throws(() => resolveLiveFingerprint(database, resolved), isIntegrityError);
    assert.deepEqual(database.prepare('SELECT * FROM repository_fingerprints WHERE repository_id = ?').get(resolved.repositoryId), before);
  } finally {
    database.close();
  }
});

test('a stale digest replaces even a malformed cached fingerprint with the current schema', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-stale-'));
  const manifestPath = path.join(root, 'package.json');
  await writeFile(manifestPath, JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database, migrationsDirectory);
    const resolved = project(root);
    registerProject(database, resolved);
    const initial = resolveLiveFingerprint(database, resolved);
    database.prepare('UPDATE repository_fingerprints SET fingerprint_json = ? WHERE repository_id = ?').run('{', resolved.repositoryId);
    await writeFile(manifestPath, JSON.stringify({ dependencies: { react: '^19.0.0' } }));

    const refreshed = resolveLiveFingerprint(database, resolved);
    assert.notEqual(refreshed.manifestDigest, initial.manifestDigest);
    assert.deepEqual(refreshed.frameworks, [{ name: 'React', version: '19.0.0' }]);
    const cached = database.prepare('SELECT fingerprint_json, manifest_digest FROM repository_fingerprints WHERE repository_id = ?')
      .get<{ fingerprint_json: string; manifest_digest: string }>(resolved.repositoryId)!;
    assert.deepEqual(JSON.parse(cached.fingerprint_json), refreshed);
    assert.equal(cached.manifest_digest, refreshed.manifestDigest);
  } finally {
    database.close();
  }
});

test('persists project package order by canonical code units rather than host collation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-canonical-order-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    dependencies: {
      'ä-package': '^1.0.0',
      'z-package': '^1.0.0',
      'a-package': '^1.0.0',
    },
  }));
  const fingerprint = computeProjectFingerprint(captureProjectManifestSnapshot({
    repositoryId: 'repo_canonical_order',
    repositoryRoot: root,
  }));
  assert.deepEqual(fingerprint.packages.map((item) => item.name), ['a-package', 'z-package', 'ä-package']);
});

test('missing manifests are absent but supported manifest parse and read failures propagate', async () => {
  const missingRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-missing-'));
  const empty = computeProjectFingerprint(captureProjectManifestSnapshot({ repositoryId: 'repo_empty', repositoryRoot: missingRoot }));
  assert.equal(empty.manifestDigest, createHash('sha256').update('', 'utf8').digest('hex'));
  assert.deepEqual(empty.packages, []);

  const malformedRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-malformed-'));
  await writeFile(path.join(malformedRoot, 'package.json'), '{');
  assert.throws(
    () => computeProjectFingerprint(captureProjectManifestSnapshot({ repositoryId: 'repo_malformed', repositoryRoot: malformedRoot })),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );

  const nonObjectRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-non-object-'));
  await writeFile(path.join(nonObjectRoot, 'package.json'), '[]');
  assert.throws(
    () => computeProjectFingerprint(captureProjectManifestSnapshot({ repositoryId: 'repo_non_object', repositoryRoot: nonObjectRoot })),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );

  const malformedDependenciesRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-dependencies-'));
  await writeFile(path.join(malformedDependenciesRoot, 'package.json'), JSON.stringify({ dependencies: [] }));
  assert.throws(
    () => computeProjectFingerprint(captureProjectManifestSnapshot({ repositoryId: 'repo_bad_dependencies', repositoryRoot: malformedDependenciesRoot })),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );

  const readFailureRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-read-failure-'));
  await mkdir(path.join(readFailureRoot, 'package.json'));
  assert.throws(
    () => captureProjectManifestSnapshot({ repositoryId: 'repo_read_failure', repositoryRoot: readFailureRoot }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'SECURITY_REJECTION',
  );
});

test('manifest capture rejects links, oversize inputs, ambiguous JSON, and aggregate overflow', async (context) => {
  if (process.platform !== 'win32') {
    const symlinkRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-symlink-'));
    const external = path.join(await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-external-')), 'package.json');
    await writeFile(external, JSON.stringify({ dependencies: { react: '^19.0.0' } }));
    await symlink(external, path.join(symlinkRoot, 'package.json'));
    assert.throws(
      () => captureProjectManifestSnapshot({ repositoryId: 'repo_symlink', repositoryRoot: symlinkRoot }),
      (error: unknown) => error instanceof KiokukoError && error.code === 'SECURITY_REJECTION',
    );
  } else {
    context.diagnostic('symlink creation is not portable in an unprivileged Windows test process');
  }

  const oversizeRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-oversize-'));
  await writeFile(path.join(oversizeRoot, 'package.json'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
  assert.throws(
    () => captureProjectManifestSnapshot({ repositoryId: 'repo_oversize', repositoryRoot: oversizeRoot }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );

  const aggregateRoot = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-aggregate-'));
  await writeFile(path.join(aggregateRoot, 'composer.json'), Buffer.alloc(4 * 1024 * 1024, 0x20));
  await writeFile(path.join(aggregateRoot, 'package.json'), Buffer.alloc(4 * 1024 * 1024, 0x20));
  await writeFile(path.join(aggregateRoot, 'go.mod'), 'x');
  assert.throws(
    () => captureProjectManifestSnapshot({ repositoryId: 'repo_aggregate', repositoryRoot: aggregateRoot }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );

  for (const [label, source] of [
    ['duplicate', '{"dependencies":{"svelte":"^5"},"dependencies":{"react":"^19"}}'],
    ['bom', '\uFEFF{"dependencies":{"svelte":"^5"}}'],
  ] as const) {
    const root = await mkdtemp(path.join(tmpdir(), `kiokuko-fingerprint-${label}-`));
    await writeFile(path.join(root, 'package.json'), source);
    const snapshot = captureProjectManifestSnapshot({ repositoryId: `repo_${label}`, repositoryRoot: root });
    assert.throws(
      () => computeProjectFingerprint(snapshot),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
});

test('captures immutable manifest identity without parsing and resolves only the captured bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-snapshot-'));
  const manifestPath = path.join(root, 'package.json');
  await writeFile(manifestPath, '{');

  const malformed = captureProjectManifestSnapshot({ repositoryId: 'repo_snapshot', repositoryRoot: root });
  assert.match(malformed.manifestDigest, /^[0-9a-f]{64}$/u);
  assert.throws(
    () => computeProjectFingerprint(malformed),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );

  await writeFile(manifestPath, JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const captured = captureProjectManifestSnapshot({ repositoryId: 'repo_snapshot', repositoryRoot: root });
  await writeFile(manifestPath, JSON.stringify({ dependencies: { react: '^19.0.0' } }));

  const fromSnapshot = computeProjectFingerprint(captured);
  const live = computeProjectFingerprint(captureProjectManifestSnapshot({ repositoryId: 'repo_snapshot', repositoryRoot: root }));
  assert.deepEqual(fromSnapshot.frameworks, [{ name: 'Svelte', version: '5.0.0' }]);
  assert.deepEqual(live.frameworks, [{ name: 'React', version: '19.0.0' }]);
  assert.equal(fromSnapshot.manifestDigest, captured.manifestDigest);
  assert.notEqual(live.manifestDigest, captured.manifestDigest);
});

test('project manifest run bindings reject malformed, duplicate, and changed identities', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-fingerprint-binding-'));
  const manifestPath = path.join(root, 'package.json');
  await writeFile(manifestPath, JSON.stringify({ dependencies: { svelte: '^5.0.0' } }));
  const resolved = project(root);
  const snapshot = captureProjectManifestSnapshot(resolved);
  const metadata = bindProjectManifestSnapshot({ source: 'test' }, resolved, snapshot);

  assert.doesNotThrow(() => assertProjectManifestSnapshotBinding(metadata, resolved, snapshot));
  assert.throws(
    () => bindProjectManifestSnapshot(metadata, resolved, snapshot),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  for (const invalid of [
    {},
    { [PROJECT_MANIFEST_BINDING_METADATA_KEY]: null },
    { [PROJECT_MANIFEST_BINDING_METADATA_KEY]: { version: 1, repositoryId: resolved.repositoryId, manifestDigest: snapshot.manifestDigest, extra: true } },
  ]) {
    assert.throws(
      () => assertProjectManifestSnapshotBinding(invalid, resolved, snapshot),
      isIntegrityError,
    );
  }

  await writeFile(manifestPath, JSON.stringify({ dependencies: { react: '^19.0.0' } }));
  const changed = captureProjectManifestSnapshot(resolved);
  assert.throws(
    () => assertProjectManifestSnapshotBinding(metadata, resolved, changed),
    (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
  );
});

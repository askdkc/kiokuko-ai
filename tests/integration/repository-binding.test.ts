import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { registerRepositoryAndLocation } from '../../src/repository/binding.js';
import { parseProjectConfig, parseProjectConfigText } from '../../src/config/project-config.js';

async function temp(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

const config = {
  schemaVersion: 1,
  repositoryId: 'repo_aaaaaaaaaaaaaaaa',
  workspace: 'project:sample-aaaaaaaa',
  agentFile: 'AGENT.md',
  templateVersion: 1,
};

test('rejects unknown binding schema versions and fields', () => {
  assert.throws(() => parseProjectConfig({ ...config, schemaVersion: 99 }), /schemaVersion/i);
  assert.throws(() => parseProjectConfig({ ...config, extra: true }), /unknown|field/i);
  assert.throws(() => parseProjectConfig({ ...config, agentFile: '../outside.md' }), /agentFile/i);
  assert.throws(() => parseProjectConfig({ ...config, agentFile: '.kiokuko.json' }), /agentFile/i);
  assert.throws(() => parseProjectConfig({ ...config, agentFile: '.KIOKUKO.JSON' }), /agentFile/i);
  assert.throws(() => parseProjectConfig({ ...config, agentFile: '.kiokuko.json/AGENTS.md' }), /agentFile/i);
  assert.throws(() => parseProjectConfig({ ...config, agentFile: 'nested/' }), /agentFile/i);
  assert.throws(() => parseProjectConfig({ ...config, agentFile: 'nested//' }), /agentFile/i);
  for (const agentFile of ['.kiokuko.json.', '.kiokuko.json::$DATA', 'AGENTS.md ', 'CON', 'aux.txt', 'nested/LPT3.md', 'nested/COM¹.txt']) {
    assert.throws(() => parseProjectConfig({ ...config, agentFile }), /agentFile/i);
  }
  assert.throws(() => parseProjectConfig({ ...config, templateVersion: 1e100 }), /templateVersion/i);
  assert.throws(() => parseProjectConfig({ ...config, workspace: 'project:ok\n<!-- BEGIN KIOKUKO MANAGED BLOCK -->' }), /workspace/i);
  assert.throws(() => parseProjectConfig({ ...config, repositoryId: 'kiokuko_global' }), /reserved global/i);
  assert.throws(() => parseProjectConfig({ ...config, workspace: 'global' }), /reserved global/i);
});

test('rejects duplicate binding keys and non-JSON syntax', () => {
  const canonical = JSON.stringify(config);
  assert.throws(
    () => parseProjectConfigText(canonical.replace('"repositoryId":', '"repositoryId":"repo_shadowed","repositoryId":')),
    /valid JSON with unique keys/u,
  );
  assert.throws(() => parseProjectConfigText(`/* comment */${canonical}`), /valid JSON with unique keys/u);
  assert.throws(() => parseProjectConfigText(`${canonical.slice(0, -1)},}`), /valid JSON with unique keys/u);
});

test('project config snapshots only enumerable own data properties and rejects proxies', () => {
  let getterCalls = 0;
  const accessor = {
    ...config,
    get workspace() {
      getterCalls += 1;
      return getterCalls === 1 ? config.workspace : 'global';
    },
  };
  assert.throws(() => parseProjectConfig(accessor), /data property/i);
  assert.equal(getterCalls, 0);

  const proxied = new Proxy({ ...config }, {});
  assert.throws(() => parseProjectConfig(proxied), /JSON object/i);

  const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
  Object.assign(inherited, config);
  assert.throws(() => parseProjectConfig(inherited), /JSON object/i);

  const hidden = { ...config };
  Object.defineProperty(hidden, 'workspace', { value: config.workspace, enumerable: false });
  assert.throws(() => parseProjectConfig(hidden), /enumerable data property/i);
});

test('repository registration rejects identity injection before database mutation', async () => {
  const directory = await temp('binding-identity-validation');
  const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  try {
    migrateDatabase(connection);
    assert.throws(() => registerRepositoryAndLocation(connection, {
      repositoryId: 'repo`injected',
      workspace: 'project:injected',
      displayName: 'injected',
      canonicalRoot: path.join(directory, 'clone'),
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    }), /repositoryId/u);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    connection.close();
  }
});

test('repository registration rejects either reserved global identity before database mutation', async () => {
  const directory = await temp('binding-reserved-global');
  const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  try {
    migrateDatabase(connection);
    for (const identity of [
      { repositoryId: 'kiokuko_global', workspace: 'project:not-global' },
      { repositoryId: 'repo_not_global', workspace: 'global' },
    ]) {
      assert.throws(() => registerRepositoryAndLocation(connection, {
        ...identity,
        displayName: 'reserved',
        canonicalRoot: path.join(directory, identity.repositoryId),
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 1,
      }), /reserved global/i);
    }
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    connection.close();
  }
});

test('registers one repository at multiple canonical locations transactionally', async () => {
  const directory = await temp('binding');
  const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  try {
    migrateDatabase(connection);
    const first = registerRepositoryAndLocation(connection, {
      repositoryId: config.repositoryId,
      workspace: config.workspace,
      displayName: 'sample',
      canonicalRoot: path.join(directory, 'clone-a'),
      remoteFingerprint: 'sha256:' + '1'.repeat(64),
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    });
    const second = registerRepositoryAndLocation(connection, {
      repositoryId: config.repositoryId,
      workspace: config.workspace,
      displayName: 'sample',
      canonicalRoot: path.join(directory, 'clone-b'),
      remoteFingerprint: 'sha256:' + '1'.repeat(64),
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS count FROM repository_locations WHERE repository_id = ?').get<{ count: number }>(config.repositoryId)?.count,
      2,
    );
  } finally {
    connection.close();
  }
});

test('rejects a root or workspace conflict with a different repository identity', async () => {
  const directory = await temp('binding-conflict');
  const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  try {
    migrateDatabase(connection);
    const root = path.join(directory, 'clone');
    registerRepositoryAndLocation(connection, {
      repositoryId: 'repo_first',
      workspace: 'project:first-111111',
      displayName: 'first',
      canonicalRoot: root,
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    });
    assert.throws(
      () => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_second',
        workspace: 'project:second-222222',
        displayName: 'second',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 1,
      }),
      /conflict|rebind/i,
    );
    assert.throws(
      () => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_third',
        workspace: 'project:first-111111',
        displayName: 'third',
        canonicalRoot: path.join(directory, 'other-clone'),
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 1,
      }),
      /workspace|conflict/i,
    );
    assert.throws(
      () => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_raw_remote',
        workspace: 'project:raw-333333',
        displayName: 'raw',
        canonicalRoot: path.join(directory, 'raw-clone'),
        remoteFingerprint: 'https://user:secret@example.com/org/repo.git',
        bindingSchemaVersion: 1,
        agentTemplateVersion: 1,
      }),
      /fingerprint|remote/i,
    );
  } finally {
    connection.close();
  }
});

test('rebind replaces only the exact planned location owner in one transaction', async () => {
  const directory = await temp('binding-rebind');
  const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  try {
    migrateDatabase(connection);
    const root = path.join(directory, 'clone');
    registerRepositoryAndLocation(connection, {
      repositoryId: 'repo_rebind_source',
      workspace: 'project:rebind-source',
      displayName: 'source',
      canonicalRoot: root,
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    });

    registerRepositoryAndLocation(connection, {
      repositoryId: 'repo_rebind_target',
      workspace: 'project:rebind-target',
      displayName: 'target',
      canonicalRoot: root,
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 2,
      rebindFrom: {
        repositoryId: 'repo_rebind_source',
        workspace: 'project:rebind-source',
      },
    });

    const rebound = connection.prepare(`
        SELECT r.repository_id AS repositoryId, r.workspace AS workspace,
               l.canonical_root AS canonicalRoot
        FROM repositories r
        JOIN repository_locations l ON l.repository_id = r.repository_id
        WHERE l.canonical_root = ?
      `).get<{ repositoryId: string; workspace: string; canonicalRoot: string }>(root);
    assert.equal(rebound?.repositoryId, 'repo_rebind_target');
    assert.equal(rebound?.workspace, 'project:rebind-target');
    assert.equal(rebound?.canonicalRoot, root);

    assert.throws(() => registerRepositoryAndLocation(connection, {
      repositoryId: 'repo_rebind_other',
      workspace: 'project:rebind-other',
      displayName: 'other',
      canonicalRoot: root,
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 2,
      rebindFrom: {
        repositoryId: 'repo_rebind_source',
        workspace: 'project:rebind-source',
      },
    }), /changed after rebind planning/i);

    assert.equal(
      connection.prepare('SELECT workspace FROM repositories WHERE repository_id = ?')
        .get<{ workspace: string }>('repo_rebind_source')?.workspace,
      'project:rebind-source',
    );
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS count FROM repositories WHERE repository_id = ?')
        .get<{ count: number }>('repo_rebind_other')?.count,
      0,
    );
  } finally {
    connection.close();
  }
});

test('rebind rejects changing the workspace of an existing repository identity', async () => {
  const directory = await temp('binding-rebind-shared');
  const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  try {
    migrateDatabase(connection);
    const firstRoot = path.join(directory, 'clone-a');
    const secondRoot = path.join(directory, 'clone-b');
    for (const canonicalRoot of [firstRoot, secondRoot]) {
      registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_shared_rebind',
        workspace: 'project:shared-before',
        displayName: 'shared',
        canonicalRoot,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 1,
      });
    }

    assert.throws(() => registerRepositoryAndLocation(connection, {
      repositoryId: 'repo_shared_rebind',
      workspace: 'project:shared-after',
      displayName: 'shared',
      canonicalRoot: firstRoot,
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 2,
      rebindFrom: {
        repositoryId: 'repo_shared_rebind',
        workspace: 'project:shared-before',
      },
    }), /another workspace/i);

    assert.equal(
      connection.prepare('SELECT workspace FROM repositories WHERE repository_id = ?')
        .get<{ workspace: string }>('repo_shared_rebind')?.workspace,
      'project:shared-before',
    );
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS count FROM repository_locations WHERE repository_id = ?')
        .get<{ count: number }>('repo_shared_rebind')?.count,
      2,
    );
  } finally {
    connection.close();
  }
});

test('registration verifies every existing-row update changed exactly one row and rolls back earlier updates', async () => {
  for (const ignoredUpdate of ['repository', 'location'] as const) {
    const directory = await temp(`binding-cas-${ignoredUpdate}`);
    const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
    try {
      migrateDatabase(connection);
      const root = path.join(directory, 'clone');
      const initialNow = '2026-01-01T00:00:00.000Z';
      registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_cas_owner',
        workspace: 'project:cas-owner',
        displayName: 'before',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 1,
        now: initialNow,
      });
      connection.exec(ignoredUpdate === 'repository'
        ? `
            CREATE TRIGGER ignore_repository_registration_update
            BEFORE UPDATE ON repositories
            BEGIN
              SELECT RAISE(IGNORE);
            END
          `
        : `
            CREATE TRIGGER ignore_repository_location_update
            BEFORE UPDATE ON repository_locations
            BEGIN
              SELECT RAISE(IGNORE);
            END
          `);

      assert.throws(() => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_cas_owner',
        workspace: 'project:cas-owner',
        displayName: 'after',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 2,
        now: '2026-01-02T00:00:00.000Z',
      }), ignoredUpdate === 'repository'
        ? /metadata changed after registration planning/i
        : /location changed after registration planning/i);

      const repositoryState = connection.prepare(`
          SELECT display_name AS displayName, agent_template_version AS agentTemplateVersion,
                 last_used_at AS lastUsedAt
          FROM repositories
          WHERE repository_id = ?
        `).get<{ displayName: string; agentTemplateVersion: number; lastUsedAt: string }>('repo_cas_owner');
      assert.equal(repositoryState?.displayName, 'before');
      assert.equal(repositoryState?.agentTemplateVersion, 1);
      assert.equal(repositoryState?.lastUsedAt, initialNow);
      assert.equal(
        connection.prepare('SELECT last_seen_at AS lastSeenAt FROM repository_locations WHERE canonical_root = ?')
          .get<{ lastSeenAt: string }>(root)?.lastSeenAt,
        initialNow,
      );
    } finally {
      connection.close();
    }
  }
});

test('rebind verifies the location-owner CAS and rolls back a newly created target repository', async () => {
  const directory = await temp('binding-rebind-cas');
  const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  try {
    migrateDatabase(connection);
    const root = path.join(directory, 'clone');
    registerRepositoryAndLocation(connection, {
      repositoryId: 'repo_rebind_cas_source',
      workspace: 'project:rebind-cas-source',
      displayName: 'source',
      canonicalRoot: root,
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    });
    connection.exec(`
      CREATE TRIGGER ignore_repository_location_rebind
      BEFORE UPDATE OF repository_id ON repository_locations
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);

    assert.throws(() => registerRepositoryAndLocation(connection, {
      repositoryId: 'repo_rebind_cas_target',
      workspace: 'project:rebind-cas-target',
      displayName: 'target',
      canonicalRoot: root,
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 2,
      rebindFrom: {
        repositoryId: 'repo_rebind_cas_source',
        workspace: 'project:rebind-cas-source',
      },
    }), /location changed after rebind planning/i);

    assert.equal(
      connection.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
        .get<{ repositoryId: string }>(root)?.repositoryId,
      'repo_rebind_cas_source',
    );
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS count FROM repositories WHERE repository_id = ?')
        .get<{ count: number }>('repo_rebind_cas_target')?.count,
      0,
    );
  } finally {
    connection.close();
  }
});

test('rebind verifies the committed repository and workspace pair after trigger side effects', async () => {
  const directory = await temp('binding-rebind-final-identity');
  const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  try {
    migrateDatabase(connection);
    const root = path.join(directory, 'clone');
    registerRepositoryAndLocation(connection, {
      repositoryId: 'repo_rebind_final_source',
      workspace: 'project:rebind-final-source',
      displayName: 'source',
      canonicalRoot: root,
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    });
    connection.exec(`
      CREATE TRIGGER replace_rebound_repository_workspace
      AFTER UPDATE OF repository_id ON repository_locations
      BEGIN
        UPDATE repositories
        SET workspace = 'project:trigger-replaced-workspace'
        WHERE repository_id = NEW.repository_id;
      END
    `);

    assert.throws(() => registerRepositoryAndLocation(connection, {
      repositoryId: 'repo_rebind_final_target',
      workspace: 'project:rebind-final-target',
      displayName: 'target',
      canonicalRoot: root,
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 2,
      rebindFrom: {
        repositoryId: 'repo_rebind_final_source',
        workspace: 'project:rebind-final-source',
      },
    }), /did not commit the planned binding identity/i);

    assert.equal(
      connection.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
        .get<{ repositoryId: string }>(root)?.repositoryId,
      'repo_rebind_final_source',
    );
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS count FROM repositories WHERE repository_id = ?')
        .get<{ count: number }>('repo_rebind_final_target')?.count,
      0,
    );
  } finally {
    connection.close();
  }
});

test('repository registration rejects invalid requested version metadata before mutation', async () => {
  const directory = await temp('binding-invalid-requested-version');
  const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
  try {
    migrateDatabase(connection);
    const base = {
      repositoryId: 'repo_invalid_requested_version',
      workspace: 'project:invalid-requested-version',
      displayName: 'invalid',
      canonicalRoot: path.join(directory, 'clone'),
      remoteFingerprint: null,
      bindingSchemaVersion: 1,
      agentTemplateVersion: 1,
    };
    const invalidVersions: Array<Record<string, unknown>> = [
      { bindingSchemaVersion: 0 },
      { bindingSchemaVersion: 1.5 },
      { bindingSchemaVersion: Number.MAX_SAFE_INTEGER + 1 },
      { bindingSchemaVersion: '1' },
      { agentTemplateVersion: -1 },
      { agentTemplateVersion: 1.5 },
      { agentTemplateVersion: Number.MAX_SAFE_INTEGER + 1 },
      { agentTemplateVersion: '1' },
    ];
    for (const invalid of invalidVersions) {
      assert.throws(
        () => registerRepositoryAndLocation(connection, {
          ...base,
          ...invalid,
        } as typeof base),
        /safe integer/i,
      );
    }
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
  } finally {
    connection.close();
  }
});

test('registration and rebind reject newer stored versions without partial mutation', async () => {
  for (const newer of [
    { column: 'binding_schema_version', value: 2 },
    { column: 'agent_template_version', value: 9 },
  ] as const) {
    const directory = await temp(`binding-newer-stored-${newer.column}`);
    const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
    try {
      migrateDatabase(connection);
      const root = path.join(directory, 'clone');
      const initialNow = '2026-01-01T00:00:00.000Z';
      registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_newer_stored_source',
        workspace: 'project:newer-stored-source',
        displayName: 'before',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 8,
        now: initialNow,
      });
      connection.prepare(`UPDATE repositories SET ${newer.column} = ? WHERE repository_id = ?`)
        .run(newer.value, 'repo_newer_stored_source');

      assert.throws(() => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_newer_stored_source',
        workspace: 'project:newer-stored-source',
        displayName: 'after',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 8,
        now: '2026-01-02T00:00:00.000Z',
      }), /newer binding or agent-template version/i);

      assert.throws(() => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_newer_stored_target',
        workspace: 'project:newer-stored-target',
        displayName: 'target',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 8,
        rebindFrom: {
          repositoryId: 'repo_newer_stored_source',
          workspace: 'project:newer-stored-source',
        },
      }), /newer binding or agent-template version/i);

      const source = connection.prepare(`
          SELECT display_name AS displayName, binding_schema_version AS bindingSchemaVersion,
                 agent_template_version AS agentTemplateVersion, last_used_at AS lastUsedAt
          FROM repositories
          WHERE repository_id = ?
        `).get<{
          displayName: string;
          bindingSchemaVersion: number;
          agentTemplateVersion: number;
          lastUsedAt: string;
        }>('repo_newer_stored_source');
      assert.equal(source?.displayName, 'before');
      assert.equal(source?.bindingSchemaVersion, newer.column === 'binding_schema_version' ? 2 : 1);
      assert.equal(source?.agentTemplateVersion, newer.column === 'agent_template_version' ? 9 : 8);
      assert.equal(source?.lastUsedAt, initialNow);
      assert.equal(
        connection.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
          .get<{ repositoryId: string }>(root)?.repositoryId,
        'repo_newer_stored_source',
      );
      assert.equal(
        connection.prepare('SELECT COUNT(*) AS count FROM repositories WHERE repository_id = ?')
          .get<{ count: number }>('repo_newer_stored_target')?.count,
        0,
      );
    } finally {
      connection.close();
    }
  }
});

test('repository registration rejects corrupt stored version metadata without mutation', async () => {
  for (const corrupt of [
    { column: 'binding_schema_version', value: 'future' },
    { column: 'agent_template_version', value: 'future' },
    { column: 'binding_schema_version', value: -1 },
    { column: 'agent_template_version', value: 1.5 },
  ] as const) {
    const directory = await temp(`binding-corrupt-stored-${corrupt.column}-${String(corrupt.value)}`);
    const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
    try {
      migrateDatabase(connection);
      const root = path.join(directory, 'clone');
      const initialNow = '2026-01-01T00:00:00.000Z';
      registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_corrupt_stored',
        workspace: 'project:corrupt-stored',
        displayName: 'before',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 8,
        now: initialNow,
      });
      connection.prepare(`UPDATE repositories SET ${corrupt.column} = ? WHERE repository_id = ?`)
        .run(corrupt.value, 'repo_corrupt_stored');

      assert.throws(() => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_corrupt_stored',
        workspace: 'project:corrupt-stored',
        displayName: 'after',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 8,
        now: '2026-01-02T00:00:00.000Z',
      }), /stored repository binding version metadata is invalid/i);

      assert.equal(
        connection.prepare('SELECT display_name AS displayName FROM repositories WHERE repository_id = ?')
          .get<{ displayName: string }>('repo_corrupt_stored')?.displayName,
        'before',
      );
      assert.equal(
        connection.prepare('SELECT last_used_at AS lastUsedAt FROM repositories WHERE repository_id = ?')
          .get<{ lastUsedAt: string }>('repo_corrupt_stored')?.lastUsedAt,
        initialNow,
      );
      assert.equal(
        connection.prepare('SELECT COUNT(*) AS count FROM repository_locations WHERE canonical_root = ?')
          .get<{ count: number }>(root)?.count,
        1,
      );
    } finally {
      connection.close();
    }
  }
});

test('rebind rolls back when trigger side effects replace planned version metadata', async () => {
  for (const versionUpdate of [
    "binding_schema_version = 2",
    "agent_template_version = 9",
  ] as const) {
    const directory = await temp(`binding-rebind-final-version-${versionUpdate.split(' ')[0]}`);
    const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
    try {
      migrateDatabase(connection);
      const root = path.join(directory, 'clone');
      registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_rebind_version_source',
        workspace: 'project:rebind-version-source',
        displayName: 'source',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 8,
      });
      connection.exec(`
        CREATE TRIGGER replace_rebound_repository_version
        AFTER INSERT ON repositories
        WHEN NEW.repository_id = 'repo_rebind_version_target'
        BEGIN
          UPDATE repositories
          SET ${versionUpdate}
          WHERE repository_id = NEW.repository_id;
        END
      `);

      assert.throws(() => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_rebind_version_target',
        workspace: 'project:rebind-version-target',
        displayName: 'target',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 8,
        rebindFrom: {
          repositoryId: 'repo_rebind_version_source',
          workspace: 'project:rebind-version-source',
        },
      }), /did not commit the planned binding version metadata/i);

      assert.equal(
        connection.prepare('SELECT repository_id AS repositoryId FROM repository_locations WHERE canonical_root = ?')
          .get<{ repositoryId: string }>(root)?.repositoryId,
        'repo_rebind_version_source',
      );
      assert.equal(
        connection.prepare('SELECT COUNT(*) AS count FROM repositories WHERE repository_id = ?')
          .get<{ count: number }>('repo_rebind_version_target')?.count,
        0,
      );
    } finally {
      connection.close();
    }
  }
});

test('location-only version sentinel still verifies the exact final agent version', async () => {
  for (const existing of [false, true]) {
    const directory = await temp(`binding-agent-version-sentinel-${existing ? 'existing' : 'new'}`);
    const connection = openConnection(path.join(directory, 'kiokuko-ai.sqlite'));
    try {
      migrateDatabase(connection);
      const root = path.join(directory, 'clone');
      const initialNow = '2026-01-01T00:00:00.000Z';
      if (existing) {
        registerRepositoryAndLocation(connection, {
          repositoryId: 'repo_agent_version_sentinel',
          workspace: 'project:agent-version-sentinel',
          displayName: 'before',
          canonicalRoot: root,
          remoteFingerprint: null,
          bindingSchemaVersion: 1,
          agentTemplateVersion: 8,
          now: initialNow,
        });
      }
      connection.exec(existing
        ? `
            CREATE TRIGGER replace_existing_agent_version
            AFTER UPDATE ON repositories
            WHEN NEW.repository_id = 'repo_agent_version_sentinel'
            BEGIN
              UPDATE repositories
              SET agent_template_version = 7
              WHERE repository_id = NEW.repository_id;
            END
          `
        : `
            CREATE TRIGGER replace_new_agent_version
            AFTER INSERT ON repositories
            WHEN NEW.repository_id = 'repo_agent_version_sentinel'
            BEGIN
              UPDATE repositories
              SET agent_template_version = 9
              WHERE repository_id = NEW.repository_id;
            END
          `);

      assert.throws(() => registerRepositoryAndLocation(connection, {
        repositoryId: 'repo_agent_version_sentinel',
        workspace: 'project:agent-version-sentinel',
        displayName: 'after',
        canonicalRoot: root,
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 0,
        now: '2026-01-02T00:00:00.000Z',
      }), /did not commit the planned binding version metadata/i);

      if (existing) {
        const row = connection.prepare(`
            SELECT display_name AS displayName, agent_template_version AS agentTemplateVersion,
                   last_used_at AS lastUsedAt
            FROM repositories
            WHERE repository_id = ?
          `).get<{
          displayName: string;
          agentTemplateVersion: number;
          lastUsedAt: string;
        }>('repo_agent_version_sentinel');
        assert.equal(row?.displayName, 'before');
        assert.equal(row?.agentTemplateVersion, 8);
        assert.equal(row?.lastUsedAt, initialNow);
        assert.equal(
          connection.prepare('SELECT COUNT(*) AS count FROM repository_locations WHERE canonical_root = ?')
            .get<{ count: number }>(root)?.count,
          1,
        );
      } else {
        assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, 0);
        assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, 0);
      }
    } finally {
      connection.close();
    }
  }
});

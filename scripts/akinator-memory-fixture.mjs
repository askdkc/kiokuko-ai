import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../dist/db/connection.js';
import { migrateDatabase } from '../dist/db/migrate.js';
import { TaskRunService } from '../dist/task-run/service.js';
import { LedgerStore } from '../dist/ledger/store.js';

export function profileFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kiokuko-profile-evaluation-')));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/alpha.ts'), 'export const alpha = 1;');
  const database = openConnection(':memory:');
  migrateDatabase(database);
  const project = { repositoryRoot: root, repositoryId: 'repo_profile_fixture', workspace: 'project:profile-fixture' };
  const now = '2026-09-13T00:00:00.000Z';
  database.prepare(`INSERT INTO repositories(repository_id, workspace, display_name, binding_schema_version, agent_template_version, created_at, last_used_at)
    VALUES (?, ?, 'profile fixture', 1, 24, ?, ?)`).run(project.repositoryId, project.workspace, now, now);
  database.prepare('INSERT INTO repository_locations(repository_id, canonical_root, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(project.repositoryId, root, now, now);
  let serial = 0;
  return {
    database, project, now,
    source(target = 'src/alpha.ts', completed = true) {
      const run = new TaskRunService(database, { now: () => now }).createRun({ requestId: `fixture-${++serial}`, workspace: project.workspace,
        task: { title: 'Implement alpha', query: `Implement ${target}`, profileHints: { taskType: 'build', target, expected: 'Earlier condition', constraints: null } }, metadata: {} });
      if (completed) new LedgerStore(database).updateRunStatus(run.runId, 'completed', now);
      return run;
    },
    close() { database.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

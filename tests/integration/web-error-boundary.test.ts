import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { KiokukoError } from '../../src/errors.js';
import { chunkSkillMarkdown } from '../../src/skills/chunking.js';
import { requirementForOfficialSkill } from '../../src/skills/official-catalog.js';
import { importSkillSnapshot } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate } from '../../src/skills/types.js';
import { startWebServer } from '../../src/web/server.js';

test('legacy Web error responses sanitize typed Kiokuko error messages and details', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-web-error-boundary-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const candidate: SkillCandidate = {
    id: 'fixture:sveltejs/ai-tools:svelte-code-writer',
    provider: 'fixture',
    name: 'svelte-code-writer',
    slug: 'svelte-code-writer',
    source: 'sveltejs/ai-tools',
    sourceType: 'github',
    installUrl: 'https://github.com/sveltejs/ai-tools',
    installs: 0,
    duplicate: false,
    officialStatus: 'unknown',
  };
  const requirement = requirementForOfficialSkill(candidate);
  assert.ok(requirement);
  const snapshot = validateSkillSnapshot({
    candidate,
    sourceCommit: 'a'.repeat(40),
    files: [{ path: 'skills/svelte-code-writer/SKILL.md', content: '---\nname: svelte-code-writer\ndescription: safe\n---\n# Svelte Code Writer\n', primary: true }],
  });
  const imported = importSkillSnapshot(database, snapshot, chunkSkillMarkdown({
    skillName: snapshot.frontmatter.name,
    sourcePath: snapshot.files[0]!.path,
    markdown: snapshot.files[0]!.content,
    summary: snapshot.frontmatter.description,
    stripFrontmatter: true,
  }), requirement);
  database.close();

  const web = await startWebServer({ databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(directory, 'runtime') } });
  const originalFetch = globalThis.fetch;
  try {
    const session = await originalFetch(web.url);
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const sentinel = 'private-typed-web-sentinel';
    globalThis.fetch = async () => {
      throw new KiokukoError('INTEGRITY_ERROR', sentinel, { debug: sentinel });
    };

    const response = await originalFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}/refresh`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body.includes(sentinel), false);
    assert.deepEqual(JSON.parse(body).error, { code: 'INTEGRITY_ERROR', message: 'Internal integrity error', details: {} });
  } finally {
    globalThis.fetch = originalFetch;
    await web.close();
  }
});

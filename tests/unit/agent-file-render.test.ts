import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BEGIN_MARKER, END_MARKER } from '../../src/agent-file/managed-block.js';
import { renderAgentFile, renderManagedBlock } from '../../src/agent-file/render.js';
import { KiokukoError } from '../../src/errors.js';

test('template placeholders produce exactly the programmatic managed block', async () => {
  const values = {
    repositoryId: 'repo-fixture',
    workspace: 'workspace-fixture',
    cliCommand: 'kiokuko-ai' as const,
  };
  const template = await readFile(new URL('../../templates/AGENTS.md', import.meta.url), 'utf8');
  const start = template.indexOf(BEGIN_MARKER);
  const end = template.indexOf(END_MARKER, start) + END_MARKER.length;
  const fixtureTemplate = template
    .slice(start, end)
    .replaceAll('{{REPOSITORY_ID}}', values.repositoryId)
    .replaceAll('{{WORKSPACE}}', values.workspace)
    .replaceAll('{{CLI_COMMAND}}', values.cliCommand);

  assert.equal(fixtureTemplate.replace(/\r\n/g, '\n'), renderManagedBlock(values));
});

test('renders the non-blocking memory-first lifecycle without legacy gateway commands or secrets', () => {
  const rendered = renderManagedBlock({
    repositoryId: 'repo-fixture',
    workspace: 'workspace-fixture',
    cliCommand: 'kiokuko-ai',
  });

  assert.match(rendered, /<!-- kiokuko-template-version: 23 -->/);
  assert.match(rendered, /memory-and-plan sidecar, not a coding gate/);
  assert.match(rendered, /unresolved advisory intake, missing Skills, failed enrichment, model fallback, verifier disagreement, and meditation delay/);
  assert.match(rendered, /Only safety, missing authorization for an irreversible effect, path or identity violations, database corruption, and stale revision or lease identity may block adoption/);
  assert.match(rendered, /Akinator questions are advisory when `continuationPolicy\.codingAllowed=true`/);
  assert.match(rendered, /claim resource-compatible Goki WorkUnits atomically/);
  assert.match(rendered, /exact revision, WorkUnit, attempt, lease token, route epoch, and input-manifest digest/);
  assert.match(rendered, /Keep final Oduno meditation separate from compaction meditation/);
  assert.match(rendered, /`task_context_read` only at idle or compaction boundaries/);
  assert.match(rendered, /Reuse an ID only for an exact transport retry; changed bound input under the same ID is a conflict/);
  assert.match(rendered, /Never install or execute a fetched external `SKILL\.md` automatically/);
  assert.match(rendered, /continue from current repository evidence and report the missing enrichment/);
  assert.match(rendered, /passwords, API keys, access tokens, private keys, session cookies/);
  assert.doesNotMatch(rendered, /server status|agent open|agent answer|agent events|agent close/);
  assert.doesNotMatch(rendered, /\/home\/|\/tmp\/|\.sqlite3?/);
  assert.doesNotMatch(rendered, /Authorization:\s*Bearer|capability token|server\.json|named-client/);
  assert.doesNotMatch(rendered, /userFacingRecovery|Plan-start recovery|continuation pause/iu);
});
test('managed markers must be exact standalone canonical lines', () => {
  for (const existing of [
    `human ${BEGIN_MARKER}\n${END_MARKER}\n`,
    `  ${BEGIN_MARKER}\n${END_MARKER}\n`,
    `${BEGIN_MARKER}\nprose ${END_MARKER}\n`,
  ]) {
    assert.throws(
      () => renderAgentFile(existing, {
        repositoryId: 'repo-fixture',
        workspace: 'project:fixture',
        cliCommand: 'kiokuko-ai',
      }),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
});

test('agent renderer rejects identity injection before interpolation', () => {
  assert.throws(
    () => renderManagedBlock({
      repositoryId: 'repo`injected',
      workspace: 'project:fixture',
      cliCommand: 'kiokuko-ai',
    }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});

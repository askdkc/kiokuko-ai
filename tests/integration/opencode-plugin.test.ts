import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KiokukoPlugin } from '../../src/opencode/plugin.js';
import { pluginContextFixture } from '../fixtures/opencode-v2-plugin.js';

test('plugin startup creates an ignore file when the project has none', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'plugin-trace-ignore-new-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cleanup = await KiokukoPlugin.setup(pluginContextFixture(root).ctx);
  await cleanup?.();
  assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), '.agenticreplay/\n');
});

test('plugin startup ignores AgenticReplay data and preserves existing rules on reload', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'plugin-trace-ignore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const file = path.join(root, '.gitignore');
  await writeFile(file, 'node_modules/\r\n.env', { mode: 0o640 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const fixture = pluginContextFixture(root);
    const cleanup = await KiokukoPlugin.setup(fixture.ctx);
    await cleanup?.();
    assert.equal(await readFile(file, 'utf8'), 'node_modules/\r\n.env\r\n.agenticreplay/\r\n');
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    assert.equal(execFileSync('git', ['check-ignore', '.agenticreplay/runs/api.json'], { cwd: root, encoding: 'utf8' }).trim(), '.agenticreplay/runs/api.json');
  }
});

test('v2 compaction hook does not trust observed run identity without a DB binding', async () => {
  const fixture = pluginContextFixture();
  const cleanup = await KiokukoPlugin.setup(fixture.ctx);
  const after = fixture.hooks.get('tool:execute.after');
  const compact = fixture.hooks.get('session:compaction');
  assert.ok(after && compact);
  await after({ tool: 'kiokuko_task_prepare', sessionID: 'ses_1', id: 'call_1', status: 'completed',
    result: { output: JSON.stringify({
      run: { runId: 'run_exact' }, project: { workspace: 'project:exact' },
      ennoOduno: { applicable: true, status: 'oduno_ideal', orchestrationId: 'orch_exact',
        contractRevision: 1, routeEpoch: 0, currentRole: 'enno-oduno', nextAction: 'submit_ideal',
        directive: { runId: 'run_exact', reportSchema: { required: ['runId'] } } },
    }) },
  } as never);
  const system = [{ type: 'text', text: 'Another plugin context' }];
  await compact({ sessionID: 'ses_1', system } as never);
  assert.equal(system[0]?.text, 'Another plugin context');
  assert.equal(system.length, 1);
  await cleanup?.();
});

test('terminal run result is absent from subsequent compaction context', async () => {
  const fixture = pluginContextFixture();
  const cleanup = await KiokukoPlugin.setup(fixture.ctx);
  const after = fixture.hooks.get('tool:execute.after')!;
  const compact = fixture.hooks.get('session:compaction')!;
  await after({ tool: 'kiokuko_task_context_read', sessionID: 'ses_1', status: 'completed',
    result: { output: JSON.stringify({ runId: 'run_done', execution: { runId: 'run_done', revision: 1, choice: 'ordinary', mode: 'ask' } }) },
  } as never);
  await after({ tool: 'kiokuko_memory_checkpoint', sessionID: 'ses_1', status: 'completed',
    result: { output: JSON.stringify({ run: { runId: 'run_done', status: 'completed' } }) },
  } as never);
  const system: Array<{ type: string; text: string }> = [];
  await compact({ sessionID: 'ses_1', system } as never);
  assert.deepEqual(system, []);
  await cleanup?.();
});

test('cleanup prevents a late execution event from starting more work', async () => {
  const fixture = pluginContextFixture();
  const cleanup = await KiokukoPlugin.setup(fixture.ctx);
  await cleanup?.();
  fixture.emit({ id: 'evt_late', type: 'session.execution.succeeded',
    data: { sessionID: 'ses_1' }, location: { directory: '/repo' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fixture.subscriptionClosed, true);
  assert.equal(fixture.values.size, 0);
});

test('an ended v2 event subscription is reopened and cleanup stops the retry', async () => {
  const fixture = pluginContextFixture();
  let subscriptions = 0;
  fixture.ctx.event.subscribe = ({ signal }: { signal: AbortSignal }) => ({
    async *[Symbol.asyncIterator]() {
      subscriptions++;
      if (subscriptions === 1) return;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  }) as never;
  const cleanup = await KiokukoPlugin.setup(fixture.ctx);
  const deadline = Date.now() + 1_000;
  while (subscriptions < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(subscriptions, 2);
  await cleanup?.();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(subscriptions, 2);
});

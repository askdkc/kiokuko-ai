import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { KiokukoPlugin } from '../../src/opencode/plugin.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

test('OpenCode plugin prompts after explicit hook approval', async () => {
  const originalBun = (globalThis as { Bun?: unknown }).Bun;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kiokuko-plugin-'));
  const executable = path.join(temporaryRoot, 'dist', 'bin', 'kiokuko.js');
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, '#!/usr/bin/env node\n');
  await writeFile(path.join(temporaryRoot, 'package.json'), JSON.stringify({ name: 'kiokuko-ai', version: PACKAGE_VERSION }));
  await chmod(executable, 0o755);
  let argv: readonly string[] = [];
  let promptCount = 0;
  (globalThis as { Bun?: unknown }).Bun = {
    spawn: (received: readonly string[]) => {
      argv = received;
      return {
        stdin: { write() {}, end() {} },
        stdout: new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            protocolVersion: 1,
            packageVersion: PACKAGE_VERSION,
            disposition: 'continue',
            code: 'continue',
            continue: true,
            runId: 'run-test',
            status: 'goki_executing',
            directive: { runId: 'run-test', contractRevision: 1 },
            reason: 'resume the approved WorkUnit',
            warning: null,
            resumeToken: 'token-test',
            routeEpoch: 1,
            executionLease: { leaseToken: 'lease-test' },
          })));
          controller.close();
        } }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
        kill() {},
      };
    },
  };
  try {
    let deliveredMessageId: string | undefined;
    const client = {
      session: {
        get: async () => ({ data: { id: 'plugin-session', directory: '/plugin-repo' } }),
        messages: async () => ({ data: [
          { info: { id: 'plugin-terminal', role: 'assistant', time: { completed: 1 } } },
          ...(deliveredMessageId === undefined ? [] : [{ info: { id: deliveredMessageId } }]),
        ] }),
        prompt: async ({ body }: { body: { messageID: string } }) => { promptCount += 1; deliveredMessageId = body.messageID; },
      },
      app: { log: async () => ({ data: true }) },
    };
    const hooks = await KiokukoPlugin({ client, directory: '/plugin-repo' } as never, {
      protocolVersion: 1,
      packageVersion: PACKAGE_VERSION,
      nodeExecutable: process.execPath,
      cliScript: executable,
    });
    assert.equal(typeof hooks.event, 'function');
    assert.equal(hooks.tool, undefined);
    await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'plugin-session', messageID: 'plugin-terminal' } } as never });
    assert.deepEqual(argv, [process.execPath, executable, 'enno', 'hook', '--input-json', '-']);
    assert.equal(promptCount, 1);
  } finally {
    (globalThis as { Bun?: unknown }).Bun = originalBun;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('OpenCode plugin carries exact Enno identity and revision through compaction', async () => {
  const client = {
    session: {
      list: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
    },
    app: { log: async () => ({ data: true }) },
  };
  const hooks = await KiokukoPlugin({ client, directory: '/repo' } as never);
  try {
    await hooks['tool.execute.after']!({
      tool: 'kiokuko_task_prepare',
      sessionID: 'compaction-session',
      callID: 'prepare-call',
      args: {},
    }, {
      title: 'prepared',
      metadata: {},
      output: JSON.stringify({
        run: { runId: 'run-exact' },
        project: { workspace: 'project:exact-workspace' },
        ennoOduno: {
          applicable: true,
          status: 'oduno_ideal',
          orchestrationId: 'orchestration-exact',
          contractRevision: 1,
          routeEpoch: 0,
          currentRole: 'enno-oduno',
          nextAction: 'submit_ideal',
          directive: { runId: 'run-exact', workUnit: null, reportSchema: { required: ['runId'] } },
        },
      }),
    });
    await hooks['tool.execute.after']!({
      tool: 'kiokuko_enno_verify_prepare',
      sessionID: 'compaction-session',
      callID: 'verify-call',
      args: {},
    }, {
      title: 'verified',
      metadata: {},
      output: JSON.stringify({
        ennoOduno: {
          applicable: true,
          status: 'enno_verifying',
          orchestrationId: 'orchestration-exact',
          contractRevision: 2,
          routeEpoch: 0,
          currentRole: 'enno-oduno',
          nextAction: 'fanout_advisory_round',
          directive: {
            runId: 'run-exact',
            workUnit: null,
            reportSchema: { required: ['runId', 'expectedRevision', 'idempotencyKey', 'review'] },
            advisoryRound: { phase: 'final_review', inputDigest: 'digest-exact' },
          },
        },
      }),
    });
    const output = { context: ['existing compaction context'] };
    await hooks['experimental.session.compacting']!({ sessionID: 'compaction-session' }, output);
    assert.equal(output.context[0], 'existing compaction context');
    assert.equal(output.context.length, 2);
    assert.match(output.context[1]!, /"runId":"run-exact"/u);
    assert.match(output.context[1]!, /"workspace":"project:exact-workspace"/u);
    assert.match(output.context[1]!, /"orchestrationId":"orchestration-exact"/u);
    assert.match(output.context[1]!, /"contractRevision":2/u);
    assert.match(output.context[1]!, /"advisoryRound":\{"phase":"final_review","inputDigest":"digest-exact"\}/u);
    assert.doesNotMatch(output.context[1]!, /\/repo/u);
  } finally {
    await hooks.dispose?.();
  }
});

test('OpenCode plugin disposal aborts and drains reconciliation before returning', async () => {
  let calls = 0;
  let aborted = 0;
  const pending = ({ signal }: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
    calls += 1;
    const stop = () => {
      aborted += 1;
      reject(new Error('aborted'));
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
  const client = {
    session: {
      list: pending,
      status: pending,
      get: async () => { throw new Error('event ingress must stay closed'); },
    },
    app: { log: async () => ({ data: true }) },
  };
  const hooks = await KiokukoPlugin({ client, directory: '/repo' } as never);
  await hooks.dispose?.();
  assert.equal(calls, 2);
  assert.equal(aborted, 2);
  await hooks.event?.({ event: { type: 'session.idle', properties: { sessionID: 'after-dispose' } } as never });
  assert.equal(calls, 2);
});

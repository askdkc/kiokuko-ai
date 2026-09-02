import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { KiokukoPlugin } from '../../src/opencode/plugin.js';

test('OpenCode plugin registers only an event hook and prompts after explicit hook approval', async () => {
  const originalBun = (globalThis as { Bun?: unknown }).Bun;
  const originalBin = process.env.KIOKUKO_BIN;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kiokuko-plugin-'));
  const executable = path.join(temporaryRoot, 'kiokuko');
  await writeFile(executable, '#!/usr/bin/env node\n');
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
            continue: true,
            runId: 'run-test',
            status: 'goki_executing',
            directive: null,
            reason: 'resume the approved WorkUnit',
            warning: null,
            resumeToken: 'token-test',
            routeEpoch: 1,
            executionLease: null,
          })));
          controller.close();
        } }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0),
        kill() {},
      };
    },
  };
  process.env.KIOKUKO_BIN = executable;
  try {
    const client = {
      session: {
        get: async () => ({ data: { id: 'plugin-session' } }),
        messages: async () => ({ data: [{ info: { id: 'plugin-terminal' } }] }),
        prompt: async () => { promptCount += 1; },
      },
      app: { log: async () => ({ data: true }) },
    };
    const hooks = await KiokukoPlugin({ client, directory: '/plugin-repo' } as never);
    assert.equal(typeof hooks.event, 'function');
    assert.equal(hooks.tool, undefined);
    await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: 'plugin-session', messageID: 'plugin-terminal' } } as never });
    assert.deepEqual(argv, [executable, 'enno', 'hook', '--client', 'opencode', '--input-json', '-']);
    assert.equal(promptCount, 1);
  } finally {
    if (originalBin === undefined) delete process.env.KIOKUKO_BIN;
    else process.env.KIOKUKO_BIN = originalBin;
    (globalThis as { Bun?: unknown }).Bun = originalBun;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

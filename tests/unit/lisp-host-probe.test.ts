import assert from 'node:assert/strict';
import test from 'node:test';
import { lispHostProbe } from '../../scripts/lib/lisp-host-probe.mjs';

type ToolReply = { role: string; tool_call_id?: string; content: string };
const schema = { function: { name: 'kiokuko_lisp', parameters: { properties: { code: { type: 'string' } } } } };
const output = (value: string, status = 'ok') => JSON.stringify({ status, output: value, stateReset: false, verification: 'untrusted_execution_output' });

function fixture(replies: (id: string, round: number) => ToolReply[], stopAfter = 1) {
  const probe = lispHostProbe();
  const stop = new Error('controlled fixture end');
  let prompts = 0, sessions = 0;
  const client = { session: {
    create: async () => ({ id: `session-${++sessions}` }),
    prompt: async () => {
      prompts++;
      if (prompts > stopAfter) throw stop;
      const sent = probe.respond({ tools: [schema] });
      assert.ok(sent && 'toolCalls' in sent);
      const id = sent.toolCalls[0]!.id;
      probe.respond({ messages: replies(id, prompts) });
    },
    wait: async () => {},
    context: async () => [{ type: 'assistant', time: { completed: 1 }, content: [] }],
    interrupt: async () => { throw stop; },
    command: async () => { throw stop; },
  } };
  return { run: () => probe.run(client, { directory: '/unused-controlled-fixture' }), stop, prompts: () => prompts };
}

for (const kind of ['wrong-id', 'missing-id', 'assistant-role'] as const) {
  test(`Lisp host probe rejects a numerically matching result with ${kind}`, async () => {
    const f = fixture(id => [{
      role: kind === 'assistant-role' ? 'assistant' : 'tool',
      ...(kind === 'missing-id' ? {} : { tool_call_id: kind === 'wrong-id' ? 'unrelated-call' : id }),
      content: output('42'),
    }]);
    await assert.rejects(f.run(), { name: 'AssertionError' });
    assert.equal(f.prompts(), 1, 'An unrelated result must not advance to another Lisp operation');
  });
}

test('Lisp host probe accepts the matching call even when an unrelated result follows it', async () => {
  const f = fixture(id => [
    { role: 'tool', tool_call_id: id, content: output('42') },
    { role: 'tool', tool_call_id: 'unrelated-call', content: output('999') },
  ]);
  await assert.rejects(f.run(), error => error === f.stop);
  assert.equal(f.prompts(), 2);
});

test('Lisp host probe does not reuse a previous call result on the next operation', async () => {
  let firstId: string;
  const f = fixture((id, round) => {
    if (round === 1) firstId = id;
    return [{ role: 'tool', tool_call_id: firstId, content: output(round === 1 ? '42' : '41') }];
  }, 2);
  await assert.rejects(f.run(), { name: 'AssertionError' });
  assert.equal(f.prompts(), 2);
});

test('Lisp host probe advances after the result of its current call arrives', async () => {
  const f = fixture(id => [{ role: 'tool', tool_call_id: id, content: output('42') }]);
  await assert.rejects(f.run(), error => error === f.stop);
  assert.equal(f.prompts(), 2);
});

test('Lisp host probe does not treat an error containing the expected number as successful evaluation', async () => {
  const f = fixture(id => [{ role: 'tool', tool_call_id: id, content: output('42', 'error') }]);
  await assert.rejects(f.run());
  assert.equal(f.prompts(), 1);
});

test('Lisp host probe requires a structured execution status rather than a matching string alone', async () => {
  const f = fixture(id => [{ role: 'tool', tool_call_id: id, content: '42' }]);
  await assert.rejects(f.run());
  assert.equal(f.prompts(), 1);
});

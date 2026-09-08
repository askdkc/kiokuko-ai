import assert from 'node:assert/strict';
import test from 'node:test';

const { createRoleCompletion } = await import(new URL('../e2e/role-completion.mjs', import.meta.url).href);
const task = { prompt: 'exact selected run and role', subagent_type: 'selected-head' };
const messages = [
  { role: 'assistant', tool_calls: [{ id: 'role-call', function: { name: 'task', arguments: JSON.stringify(task) } }] },
  { role: 'tool', tool_call_id: 'role-call', content: 'completed role' },
];

test('concurrent parent responses wait for the same delayed work report exactly once', async () => {
  let release!: (value: unknown) => void;
  const delayed = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const completion = createRoleCompletion(task, () => { calls++; return delayed; });
  const first = completion.observe(messages);
  const second = completion.observe(messages);
  assert.equal(first, second);
  assert.equal(completion.result(), first);
  let finished = false;
  void second.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(finished, false, 'Final verification cannot overtake an in-flight report');
  release({ ennoOduno: { status: 'enno_verifying' } });
  assert.deepEqual(await first, await second);
  assert.equal(completion.observe(messages), first, 'Completed report is reused');
  assert.equal(calls, 1);
});

test('unrelated, missing and malformed task results never submit a work report', () => {
  const completion = createRoleCompletion(task, () => { assert.fail('Unrelated result submitted a report'); });
  assert.equal(completion.observe(messages.slice(0, 1)), undefined);
  assert.equal(completion.observe([{ ...messages[1], tool_call_id: 'unrelated' }]), undefined);
  assert.equal(completion.observe([{ role: 'assistant', tool_calls: [{ id: 'role-call', function: { name: 'task', arguments: '{' } }] }, messages[1]]), undefined);
  assert.equal(completion.observe([{ role: 'assistant', tool_calls: [{ id: 'role-call', function: { name: 'task', arguments: JSON.stringify({ ...task, prompt: 'another run' }) } }] }, messages[1]]), undefined);
  assert.throws(() => completion.result(), /must trigger/u);
});

test('failed work reports remain failed without implicit retries', async () => {
  let calls = 0;
  const completion = createRoleCompletion(task, () => { calls++; throw new Error('Report failed'); });
  const first = completion.observe(messages);
  await assert.rejects(first, /Report failed/u);
  assert.equal(completion.observe(messages), first);
  await assert.rejects(completion.result(), /Report failed/u);
  assert.equal(calls, 1);
});

test('a continuation message after the task result cannot hide the completed role', async () => {
  let calls = 0;
  const completion = createRoleCompletion(task, () => { calls++; return 'reported'; });
  const continued = [...messages, { role: 'user', content: 'Continue this active run.' }];
  await completion.observe(continued);
  assert.equal(await completion.result(), 'reported');
  assert.equal(calls, 1);
});

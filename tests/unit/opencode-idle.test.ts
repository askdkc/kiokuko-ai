import assert from 'node:assert/strict';
import test from 'node:test';
import { readContextBoundary, readSessionSnapshot, validateSessionBinding } from '../../src/opencode/v2-adapter.js';
import { OpenCodeV2Continuation } from '../../src/opencode/v2-continuation.js';
import { completedContext, continuationFixture, trackedSession } from '../fixtures/opencode-v2.js';

function continuation(fixture: ReturnType<typeof continuationFixture>, warnings: string[] = []) {
  return new OpenCodeV2Continuation(fixture.ctx, '/repo', 'prj', {}, () => true, reason => { warnings.push(reason); }, fixture.operations);
}

test('past succeeded outcome without a current successful idle boundary cannot resume', async () => {
  const fixture = continuationFixture({ messages: completedContext().slice(0, -1) });
  assert.equal(await readContextBoundary(fixture.ctx.session, 'ses_1'), null);
  await continuation(fixture).run('ses_1', true);
  assert.equal(fixture.prompts.length, 0);
  assert.equal(fixture.values.size, 0);
});

test('an idle marker cannot authorize an assistant older than the latest user input', async () => {
  const messages = completedContext();
  messages.splice(2, 0, { type: 'user', id: 'msg_user_2', text: 'new request', time: { created: 4 } });
  const fixture = continuationFixture({ messages });
  assert.equal(await readContextBoundary(fixture.ctx.session, 'ses_1'), null);
});

test('completed execution stores a deterministic prompt ID and accepts it once', async () => {
  const fixture = continuationFixture();
  const engine = continuation(fixture);
  await engine.run('ses_1', true);
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.prompts[0]!.id, /^msg_kiokuko_[a-f0-9]{32}$/u);
  assert.equal(fixture.prompts[0]!.text, 'continue from Kiokuko');
  assert.equal(([...fixture.values.values()][0] as { phase: string }).phase, 'accepted');
  await engine.reconcileTracked();
  assert.equal(fixture.prompts.length, 1);
});

test('lost prompt response is quarantined without automatic retransmission', async () => {
  const fixture = continuationFixture({ prompt: async () => { throw new Error('connection lost'); } });
  const warnings: string[] = [];
  const engine = continuation(fixture, warnings);
  await engine.run('ses_1', true);
  await engine.reconcileTracked();
  assert.equal(fixture.prompts.length, 1);
  assert.equal(([...fixture.values.values()][0] as { phase: string }).phase, 'quarantined');
  assert.ok(warnings.includes('prompt_admission_unknown'));
});

test('restart confirms a saved sending prompt only when ID and text both match', async () => {
  const fixture = continuationFixture();
  await continuation(fixture).run('ses_1', true);
  const [key, value] = [...fixture.values][0]!;
  const outbox = value as { messageId: string; text: string };
  fixture.values.set(key, { ...outbox, ...(value as object), phase: 'sending' });
  fixture.messages.push({ type: 'user', id: outbox.messageId, text: outbox.text, time: { created: 5 } });
  await continuation(fixture).reconcileTracked();
  assert.equal((fixture.values.get(key) as { phase: string }).phase, 'accepted');
  assert.equal(fixture.prompts.length, 1);
});

test('same prompt ID with different text is quarantined', async () => {
  const fixture = continuationFixture();
  await continuation(fixture).run('ses_1', true);
  const [key, value] = [...fixture.values][0]!;
  const messageId = (value as { messageId: string }).messageId;
  fixture.values.set(key, { ...(value as object), phase: 'sending' });
  fixture.messages.push({ type: 'user', id: messageId, text: 'different content', time: { created: 5 } });
  const warnings: string[] = [];
  await continuation(fixture, warnings).reconcileTracked();
  assert.equal((fixture.values.get(key) as { phase: string }).phase, 'quarantined');
  assert.ok(warnings.includes('prompt_content_mismatch'));
  assert.equal(fixture.prompts.length, 1);
});

test('reverted or changed saved input is quarantined on restart', async () => {
  const fixture = continuationFixture();
  await continuation(fixture).run('ses_1', true);
  const [key, value] = [...fixture.values][0]!;
  fixture.values.set(key, { ...(value as object), phase: 'sending' });
  const warnings: string[] = [];
  await continuation(fixture, warnings).reconcileTracked();
  assert.equal((fixture.values.get(key) as { phase: string }).phase, 'quarantined');
  assert.ok(warnings.includes('prompt_admission_unknown'));
  assert.equal(fixture.prompts.length, 1);
});

test('restart replays a saved hook boundary without creating a new terminal identity', async () => {
  const fixture = continuationFixture({ hook: async () => { throw new Error('transport interrupted'); } });
  await continuation(fixture).run('ses_1', true);
  const [key, pending] = [...fixture.values][0]!;
  assert.equal((pending as { phase: string }).phase, 'hook_pending');
  assert.equal((pending as { hookAttempts: number }).hookAttempts, 1);
  fixture.operations.hook = async () => ({ kind: 'continue', text: 'continue from Kiokuko' });
  await continuation(fixture).reconcileTracked();
  const accepted = fixture.values.get(key) as { phase: string; hookAttempts: number; terminalMessageId: string };
  assert.equal(accepted.phase, 'accepted');
  assert.equal(accepted.hookAttempts, 2);
  assert.equal(accepted.terminalMessageId, 'msg_assistant_1');
  assert.equal(fixture.prompts.length, 1);
});

test('restart sends an unsent saved prompt unchanged and preserves the retry ceiling', async () => {
  const fixture = continuationFixture();
  await continuation(fixture).run('ses_1', true);
  const [key, accepted] = [...fixture.values][0]!;
  const original = accepted as { messageId: string; text: string; textDigest: string };
  fixture.values.set(key, { ...original, ...(accepted as object), phase: 'prompt_pending', deliveryAttempts: 0 });
  await continuation(fixture).reconcileTracked();
  assert.equal(fixture.prompts.length, 2);
  assert.deepEqual(fixture.prompts[1], fixture.prompts[0]);
  assert.equal((fixture.values.get(key) as { phase: string }).phase, 'accepted');

  fixture.values.set(key, { ...(accepted as object), phase: 'hook_pending', hookAttempts: 3 });
  await continuation(fixture).reconcileTracked();
  assert.equal((fixture.values.get(key) as { phase: string; reason: string }).reason, 'hook_retry_exhausted');
  assert.equal(fixture.prompts.length, 2);
});

test('moved repository and child session are rejected before continuation', async () => {
  const fixture = continuationFixture();
  const snapshot = await readSessionSnapshot(fixture.ctx.session, 'ses_1');
  assert.equal(validateSessionBinding(snapshot, trackedSession, '/repo', 'prj'), true);
  assert.equal(validateSessionBinding(snapshot, trackedSession, '/different', 'prj'), false);
  assert.equal(validateSessionBinding({ ...snapshot, parentID: 'parent' }, trackedSession, '/repo', 'prj'), false);
});

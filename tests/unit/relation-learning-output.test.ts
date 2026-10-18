import test from 'node:test';
import assert from 'node:assert/strict';
import { registerOpenCodeLearning, renderOpenCodeLearningContext } from '../../src/opencode/learning.js';

function input() {
  const from = { workspace: 'project:test', entryId: 'a' }, to = { workspace: 'project:test', entryId: 'b' };
  return { entries: [{ ...from, summary: '😀'.repeat(9_000) }, { ...to, summary: '反例'.repeat(1_000) }], handoff: null,
    relationDelivery: { scope: 'provided_items', status: 'complete', selectionOmissions: [],
      edges: [{ from, to, type: 'supports' }, { from, to, type: 'contradicts' }] } };
}

test('the OpenCode final model text uses 16k Unicode body characters and preserves typed metadata', () => {
  const value = input(), original = JSON.stringify(value), text = renderOpenCodeLearningContext(value)!;
  const result = JSON.parse(text);
  assert.equal(result.entries.length, 2); assert.equal(result.relationDelivery.edges.length, 2);
  assert.ok(Array.from(JSON.stringify({ entries: result.entries, handoff: result.handoff })).length > 8_000);
  assert.ok(Array.from(JSON.stringify({ entries: result.entries, handoff: result.handoff })).length <= 16_000);
  assert.ok(Array.from(JSON.stringify({ relationDelivery: result.relationDelivery })).length <= 8_000);
  assert.equal(JSON.stringify(value), original);
});

test('a final body exclusion removes all dangling edges and explicitly diagnoses the dropped contradiction endpoint', () => {
  const result = JSON.parse(renderOpenCodeLearningContext(input(), 10_000)!);
  assert.equal(result.entries.length, 1); assert.equal(result.relationDelivery.status, 'complete');
  assert.deepEqual(result.relationDelivery.edges, []);
  assert.deepEqual(result.relationDelivery.selectionOmissions, ['body_budget', 'final_filter']);
});

test('legacy, previously omitted, malformed and too-small states never silently become complete', () => {
  const value = input();
  const legacy = { entries: value.entries, handoff: null };
  assert.equal(JSON.parse(renderOpenCodeLearningContext(legacy)!).relationDelivery.status, 'omitted_legacy');
  value.relationDelivery.status = 'omitted_edge_cap'; value.relationDelivery.edges = [];
  assert.equal(JSON.parse(renderOpenCodeLearningContext(value, 10_000)!).relationDelivery.status, 'omitted_edge_cap');
  const foreign = input(); foreign.relationDelivery.edges[0]!.from.workspace = 'other';
  assert.throws(() => renderOpenCodeLearningContext(foreign), /outside/u);
  assert.throws(() => renderOpenCodeLearningContext(legacy, 1), /cannot fit/u);
});


test('the actual OpenCode context hook preserves the full rendered JSON and contradiction after 6000 characters', async t => {
  const { pluginContextFixture } = await import('../fixtures/opencode-v2-plugin.js');
  const { OpenCodePluginLifecycle } = await import('../../src/opencode/lifecycle.js');
  const fixture = pluginContextFixture(), lifecycle = new OpenCodePluginLifecycle();
  t.after(() => lifecycle.dispose(() => undefined));
  const rendered = renderOpenCodeLearningContext(input())!;
  assert.ok(Array.from(rendered).length > 8_000);
  await registerOpenCodeLearning(fixture.ctx, '/repo', lifecycle, { recall: async () => rendered }, () => undefined);
  await fixture.hooks.get('session:prompt')!({ sessionID: 'ses_1', messageID: 'relation-context', prompt: { text: 'Inspect the counterexample' } } as never);
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  const system: Array<{type:'text';text:string}> = [];
  await fixture.hooks.get('session:context')!({ sessionID: 'ses_1', system } as never);
  assert.equal(system.length, 1);
  const model = JSON.parse(system[0]!.text.slice(system[0]!.text.indexOf('\n') + 1));
  assert.equal(model.entries.length, 2);
  assert.ok(model.relationDelivery.edges.some((edge: {type:string}) => edge.type === 'contradicts'));
  assert.deepEqual(model, JSON.parse(rendered));
});

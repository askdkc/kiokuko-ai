import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error evaluation utility intentionally ships as a developer-only ES module
import { summarizeSourceLlmMessages, finalSourceLlmText } from '../../scripts/lib/source-llm-metrics.mjs';

test('LLM evaluation sums all assistant requests and keeps cache counters separate', () => {
  const response = (input: number, text: string) => ({ info: { role: 'assistant', cost: 0.01,
    tokens: { input, output: 3, reasoning: 2, cache: { read: 4, write: 5 } } },
    parts: [{ type: 'text', text }, { type: 'tool', tool: 'read', state: { status: 'completed', output: 'abc' } }] });
  const messages = [response(10,'exploring'), { info: { role: 'user' }, parts: [{ type: 'text', text: 'ignore' }] }, response(20,'final')];
  const result = summarizeSourceLlmMessages(messages);
  assert.equal(result.input, 30); assert.equal(result.cacheRead, 8); assert.equal(result.cacheWrite, 10);
  assert.equal(result.completedReads, 2); assert.equal(result.toolOutputBytes, 6);
  assert.equal(finalSourceLlmText(messages), 'final');
});

test('missing usage is unknown instead of a fabricated zero-cost success', () => {
  const result = summarizeSourceLlmMessages([{ info: { role: 'assistant', error: { name: 'ProviderAuthError' } }, parts: [] }]);
  assert.equal(result.input, null); assert.equal(result.reportedCost, null);
  assert.deepEqual(result.errors, ['ProviderAuthError']);
  assert.equal(summarizeSourceLlmMessages([]).input, null);
  assert.equal(summarizeSourceLlmMessages([{info:{role:'assistant',cost:0,
    tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}}},parts:[]}]).input, null);
  assert.equal(finalSourceLlmText([{info:{role:'assistant'},parts:[{type:'text',text:'still exploring'}]},
    {info:{role:'assistant'},parts:[]}]), '', 'do not promote intermediate text to a final plan');
});

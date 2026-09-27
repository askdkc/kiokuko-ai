import assert from 'node:assert/strict';
import test from 'node:test';

const { waitForPackedPlugin } = await import(new URL('../../scripts/lib/plugin-readiness.mjs', import.meta.url).href);

test('packed plugin wait survives more than 100 missing observations during a cold install', async () => {
  let calls = 0;
  const active = { id: 'kiokuko-ai', state: { status: 'active' } };
  const client = { plugin: { list: async () => ({ data: ++calls <= 101 ? [] : [active] }) } };

  assert.equal(await waitForPackedPlugin(client, { directory: '/fixture' }, 10_000, 0), active);
  assert.equal(calls, 102);
});

test('packed plugin wait returns host failure immediately', async () => {
  let calls = 0;
  const failed = { id: 'kiokuko-ai', state: { status: 'failed', error: 'installation failed' } };
  const client = { plugin: { list: async () => { calls++; return { data: [failed] }; } } };

  assert.equal(await waitForPackedPlugin(client, { directory: '/fixture' }, 10_000, 0), failed);
  assert.equal(calls, 1);
});

test('packed plugin wait leaves an absent plugin unverified at the deadline', async () => {
  let calls = 0;
  const client = { plugin: { list: async () => { calls++; return { data: [] }; } } };

  assert.equal(await waitForPackedPlugin(client, { directory: '/fixture' }, 0, 0), undefined);
  assert.equal(calls, 1);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { findSecret } from '../../src/memory/secrets.js';

const fixtureDirectory = path.resolve(import.meta.dirname, '../fixtures/client-events');

interface ClientEventFixture {
  schemaVersion: number;
  client: { kind: string; version: string };
  purpose?: string;
  capture: { status: 'verified' | 'partial'; method: string };
  events: Array<Record<string, unknown>>;
}

async function loadFixture(name: string): Promise<ClientEventFixture> {
  return JSON.parse(await readFile(path.join(fixtureDirectory, name), 'utf8')) as ClientEventFixture;
}

function serialized(fixture: ClientEventFixture): string {
  return JSON.stringify(fixture);
}

test('the OpenCode event fixture is versioned, bounded, and sanitized clean-room evidence', async () => {
  const fixtures = await Promise.all([
    loadFixture('opencode-1.18.18.json'),
    loadFixture('opencode-1.18.25.json'),
    loadFixture('opencode-1.18.26.json'),
  ]);

  assert.deepEqual(fixtures.map((fixture) => fixture.client.kind), ['opencode', 'opencode', 'opencode']);
  assert.match(fixtures[0]?.purpose ?? '', /regression-only/u);
  for (const fixture of fixtures) {
    assert.equal(fixture.schemaVersion, 1);
    assert.ok(fixture.client.version.length > 0);
    assert.ok(fixture.capture.method.length > 0);
    assert.ok(fixture.events.length > 0);
    const text = serialized(fixture);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 64 * 1024);
    assert.equal(findSecret(text), undefined);
    assert.doesNotMatch(text, /\/home\/|\\Users\\|transcript_path|reasoning|authorization|cookie/i);
  }
});

test('the fixture preserves only event categories observed in the OpenCode run', async () => {
  const opencode = await loadFixture('opencode-1.18.26.json');
  assert.deepEqual(opencode.events.map((event) => event.channel), [
    'event',
    'tool.execute.before',
    'shell.env',
    'tool.execute.after',
    'event',
  ]);
});

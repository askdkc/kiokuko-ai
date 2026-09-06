import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const DOCUMENT = readFileSync(fileURLToPath(new URL('../../docs/orcareplay-integration.md', import.meta.url)), 'utf8');

const REQUIRED_SECTIONS = [
  '## Trust boundary',
  '## Secret screening',
  '## Trace reader and ingestion',
  '## Trace scan CLI surface',
  '## Advisory-only delivery semantics',
];

const REQUIRED_PHRASES = [
  'read-only input',
  'findSecretInValue',
  'SECURITY_REJECTION',
  'kiokuko-ai trace scan',
  'referenceOnly',
  'autoInstall',
  'autoExecute',
  'already_ingested',
  'INTEGRITY_ERROR',
];

const FORBIDDEN_PHRASES = [
  ['client', 'neutral'].join('-'),
  ['model', 'agnostic'].join('-'),
  ['generic', 'Agent'].join(' '),
  ['', 'api', 'v1', 'agent'].join('/'),
  ['kiokuko-ai', 'agent'].join(' '),
  ['kiokuko-ai', 'serve'].join(' '),
  ['kiokuko-ai', 'call'].join(' '),
];

const FOREIGN_AGENTS = [
  ['co', 'dex'].join(''),
  ['cla', 'ude'].join(''),
  ['her', 'mes'].join(''),
  ['ai', 'der'].join(''),
  ['gem', 'ini'].join(''),
  ['wind', 'surf'].join(''),
  ['cop', 'ilot'].join(''),
];

test('the OrcaReplay integration document exists and covers the required contract', () => {
  for (const section of REQUIRED_SECTIONS) {
    assert.ok(DOCUMENT.includes(section), `missing section ${section}`);
  }
  for (const phrase of REQUIRED_PHRASES) {
    assert.ok(DOCUMENT.includes(phrase), `missing phrase ${phrase}`);
  }
});

test('the OrcaReplay integration document stays inside the OpenCode-only boundary', () => {
  for (const phrase of FORBIDDEN_PHRASES) {
    assert.equal(DOCUMENT.includes(phrase), false, `forbidden phrase ${phrase}`);
  }
  const lowercase = DOCUMENT.toLowerCase();
  for (const agent of FOREIGN_AGENTS) {
    assert.equal(lowercase.includes(agent), false, `foreign agent name ${agent}`);
  }
});

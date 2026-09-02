import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { KiokukoError } from '../../src/errors.js';
import { renderOpenCodeConfig } from '../../src/setup/opencode-config.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';

const runtime = {
  protocolVersion: 1 as const,
  packageVersion: PACKAGE_VERSION,
  nodeExecutable: '/tmp/Unicode Path/node',
  cliScript: '/tmp/Unicode Path/kiokuko-ai/dist/bin/kiokuko.js',
};

test('OpenCode setup rejects duplicate JSONC keys', () => {
  assert.throws(
    () => renderOpenCodeConfig('{"mcp":{},"mcp":{}}\n'),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});

test('OpenCode setup rejects present empty JSONC instead of treating it as a missing file', () => {
  for (const source of ['', ' \t\r\n']) {
    assert.throws(
      () => renderOpenCodeConfig(source),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
});

test('OpenCode setup writes and preserves the external Skill discovery mode', () => {
  const existing = '{\n  // keep\n  "theme": "dark"\n}\n';
  const community = renderOpenCodeConfig(existing, 'kiokuko-ai', 'community');
  const parsed = parse(community.content) as {
    theme: string;
    mcp: { kiokuko: { environment: { KIOKUKO_SKILL_DISCOVERY: string } } };
  };
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.mcp.kiokuko.environment.KIOKUKO_SKILL_DISCOVERY, 'community');
  assert.match(community.content, /\/\/ keep/u);
  assert.equal(renderOpenCodeConfig(community.content).action, 'unchanged');

  const updated = renderOpenCodeConfig(community.content, '/usr/local/bin/kiokuko');
  const updatedConfig = parse(updated.content) as {
    theme: string;
    mcp: { kiokuko: { command: string[] } };
  };
  assert.equal(updated.action, 'updated');
  assert.equal(updatedConfig.theme, 'dark');
  assert.deepEqual(updatedConfig.mcp.kiokuko.command, ['/usr/local/bin/kiokuko', 'mcp']);
});

test('OpenCode setup rejects non-canonical or modified kiokuko servers as conflicts', () => {
  const canonical = parse(renderOpenCodeConfig('{}\n').content) as {
    mcp: { kiokuko: Record<string, unknown> };
  };
  const variants: Record<string, unknown>[] = [
    { ...canonical.mcp.kiokuko, extra: true },
    { ...canonical.mcp.kiokuko, type: 'remote' },
    { ...canonical.mcp.kiokuko, command: ['human-wrapper', 'serve'] },
    { ...canonical.mcp.kiokuko, command: ['kiokuko-ai', 'mcp', '--custom'] },
    { ...canonical.mcp.kiokuko, enabled: false },
    { ...canonical.mcp.kiokuko, environment: { KIOKUKO_SKILL_DISCOVERY: 'official', PATH: '/custom' } },
    { ...canonical.mcp.kiokuko, environment: { KIOKUKO_SKILL_DISCOVERY: 'invalid' } },
  ];

  for (const kiokuko of variants) {
    const existing = `${JSON.stringify({ theme: 'keep', mcp: { other: { command: ['keep'] }, kiokuko } }, null, 2)}\n`;
    assert.throws(
      () => renderOpenCodeConfig(existing, '/new/kiokuko'),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'CONFLICT'
        && !error.message.includes('/new/kiokuko'),
    );
  }
});

test('OpenCode setup replaces only the conflicting kiokuko server after authorization', () => {
  const existing = [
    '{',
    '  // keep this comment',
    '  "theme": "keep",',
    '  "mcp": {',
    '    "other": { "command": ["keep"] },',
    '    "kiokuko": { "type": "remote", "environment": { "KIOKUKO_SKILL_DISCOVERY": "community" } }',
    '  }',
    '}',
    '',
  ].join('\n');

  const replaced = renderOpenCodeConfig(
    existing,
    '/opt/kiokuko',
    undefined,
    { replaceConflictingIdentity: true },
  );
  const parsed = parse(replaced.content) as {
    theme: string;
    mcp: { other: unknown; kiokuko: unknown };
  };
  assert.equal(parsed.theme, 'keep');
  assert.deepEqual(parsed.mcp.other, { command: ['keep'] });
  assert.deepEqual(parsed.mcp.kiokuko, {
    type: 'local',
    command: ['/opt/kiokuko', 'mcp'],
    enabled: true,
    environment: { KIOKUKO_SKILL_DISCOVERY: 'official' },
  });
  assert.match(replaced.content, /keep this comment/u);
});

test('OpenCode setup rejects invalid MCP container and requested state without rewriting config', () => {
  for (const existing of ['{"mcp":[]}\n', '{"mcp":"custom"}\n']) {
    assert.throws(
      () => renderOpenCodeConfig(existing),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
  assert.throws(
    () => renderOpenCodeConfig('{}\n', ''),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => renderOpenCodeConfig('{}\n', 'kiokuko-ai', 'official', { replaceConflictingIdentity: 'yes' as never }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});

test('OpenCode setup upgrades the plugin and MCP to one exact runtime while preserving tuple options', () => {
  const existing = JSON.stringify({
    plugin: [
      ['kiokuko-ai', { keep: 'this', packageVersion: 'old' }],
      'unrelated-plugin',
    ],
    mcp: { kiokuko: {
      type: 'local',
      command: ['kiokuko-ai', 'mcp'],
      enabled: true,
      environment: { KIOKUKO_SKILL_DISCOVERY: 'community' },
    } },
  }, null, 2) + '\n';
  const rendered = renderOpenCodeConfig(existing, 'kiokuko-ai', undefined, { runtime });
  const parsed = parse(rendered.content) as {
    plugin: unknown[];
    mcp: { kiokuko: { command: string[]; environment: Record<string, string> } };
  };
  assert.deepEqual(parsed.plugin[0], [
    `kiokuko-ai@${PACKAGE_VERSION}`,
    { keep: 'this', packageVersion: PACKAGE_VERSION, protocolVersion: 1, nodeExecutable: runtime.nodeExecutable, cliScript: runtime.cliScript },
  ]);
  assert.equal(parsed.plugin[1], 'unrelated-plugin');
  assert.deepEqual(parsed.mcp.kiokuko.command, [runtime.nodeExecutable, runtime.cliScript, 'mcp']);
  assert.deepEqual(parsed.mcp.kiokuko.environment, { KIOKUKO_SKILL_DISCOVERY: 'community' });
  assert.equal(renderOpenCodeConfig(rendered.content, 'kiokuko-ai', undefined, { runtime }).action, 'unchanged');
});

test('runtime-less plugin strings stay strings when no tuple options exist', () => {
  const rendered = renderOpenCodeConfig('{ "plugin": ["kiokuko-ai"] }\n');
  assert.deepEqual((parse(rendered.content) as { plugin: unknown[] }).plugin, [`kiokuko-ai@${PACKAGE_VERSION}`]);
});

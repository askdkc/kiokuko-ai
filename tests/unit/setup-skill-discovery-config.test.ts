import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { KiokukoError } from '../../src/errors.js';
import { renderOpenCodeConfig } from '../../src/setup/opencode-config.js';
import { PACKAGE_VERSION } from '../../src/package-version.js';
import { parseOpenCodePluginOptions } from '../../src/opencode/runtime-invocation.js';

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
    mcp: { servers: { kiokuko: { environment: { KIOKUKO_SKILL_DISCOVERY: string } } } };
  };
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.mcp.servers.kiokuko.environment.KIOKUKO_SKILL_DISCOVERY, 'community');
  assert.match(community.content, /\/\/ keep/u);
  assert.equal(renderOpenCodeConfig(community.content).action, 'unchanged');

  const updated = renderOpenCodeConfig(community.content, '/usr/local/bin/kiokuko');
  const updatedConfig = parse(updated.content) as {
    theme: string;
    mcp: { servers: { kiokuko: { command: string[] } } };
  };
  assert.equal(updated.action, 'updated');
  assert.equal(updatedConfig.theme, 'dark');
  assert.deepEqual(updatedConfig.mcp.servers.kiokuko.command, ['/usr/local/bin/kiokuko', 'mcp']);
});

test('OpenCode setup rejects non-canonical or modified kiokuko servers as conflicts', () => {
  const canonical = parse(renderOpenCodeConfig('{}\n').content) as {
    mcp: { servers: { kiokuko: Record<string, unknown> } };
  };
  const variants: Record<string, unknown>[] = [
    { ...canonical.mcp.servers.kiokuko, extra: true },
    { ...canonical.mcp.servers.kiokuko, type: 'remote' },
    { ...canonical.mcp.servers.kiokuko, command: ['human-wrapper', 'serve'] },
    { ...canonical.mcp.servers.kiokuko, command: ['kiokuko-ai', 'mcp', '--custom'] },
    { ...canonical.mcp.servers.kiokuko, disabled: true },
    { ...canonical.mcp.servers.kiokuko, environment: { KIOKUKO_SKILL_DISCOVERY: 'official', PATH: '/custom' } },
    { ...canonical.mcp.servers.kiokuko, environment: { KIOKUKO_SKILL_DISCOVERY: 'invalid' } },
  ];

  for (const kiokuko of variants) {
    const existing = `${JSON.stringify({ theme: 'keep', mcp: { servers: { other: { command: ['keep'] }, kiokuko } } }, null, 2)}\n`;
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
    mcp: { other: unknown; servers: { kiokuko: unknown } };
  };
  assert.equal(parsed.theme, 'keep');
  assert.deepEqual(parsed.mcp.other, { command: ['keep'] });
  assert.deepEqual(parsed.mcp.servers.kiokuko, {
    type: 'local',
    command: ['/opt/kiokuko', 'mcp'],
    disabled: false,
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
      'unrelated-plugin',
      ['kiokuko-ai', { keep: 'this', packageVersion: 'old' }],
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
    plugins: Array<{ package: string; options: Record<string, unknown> }>;
    mcp: { servers: { kiokuko: { command: string[]; environment: Record<string, string> } } };
  };
  assert.deepEqual(parsed.plugin, ['unrelated-plugin']);
  assert.deepEqual(parsed.plugins[0], { package: `kiokuko-ai@${PACKAGE_VERSION}`,
    options: { keep: 'this', packageVersion: PACKAGE_VERSION, protocolVersion: 1, nodeExecutable: runtime.nodeExecutable, cliScript: runtime.cliScript } });
  assert.deepEqual(parsed.mcp.servers.kiokuko.command, [runtime.nodeExecutable, runtime.cliScript, 'mcp']);
  assert.deepEqual(parsed.mcp.servers.kiokuko.environment, { KIOKUKO_SKILL_DISCOVERY: 'community' });
  assert.equal(renderOpenCodeConfig(rendered.content, 'kiokuko-ai', undefined, { runtime }).action, 'unchanged');
});

test('runtime option parsing strips preserved unmanaged plugin options', () => {
  const parsed = parseOpenCodePluginOptions({
    keep: 'this',
    protocolVersion: runtime.protocolVersion,
    packageVersion: runtime.packageVersion,
    nodeExecutable: runtime.nodeExecutable,
    cliScript: runtime.cliScript,
  });
  assert.deepEqual(parsed, runtime);
  assert.equal(Object.hasOwn(parsed ?? {}, 'keep'), false);
});

test('runtime-less plugin strings migrate to v2 package entries', () => {
  const rendered = renderOpenCodeConfig('{ "plugin": ["kiokuko-ai"] }\n');
  const parsed = parse(rendered.content) as { plugin: unknown[]; plugins: Array<{ package: string; options: object }> };
  assert.deepEqual(parsed.plugin, []);
  assert.deepEqual(parsed.plugins, [{ package: `kiokuko-ai@${PACKAGE_VERSION}`, options: {} }]);
});

test('identical legacy and v2 MCP identities collapse without altering other servers', () => {
  const legacy = { type: 'local', command: ['kiokuko-ai', 'mcp'], enabled: true,
    environment: { KIOKUKO_SKILL_DISCOVERY: 'community' } };
  const current = { type: 'local', command: [runtime.nodeExecutable, runtime.cliScript, 'mcp'], disabled: false,
    environment: { KIOKUKO_SKILL_DISCOVERY: 'community' } };
  const source = JSON.stringify({ mcp: { kiokuko: legacy, servers: { kiokuko: current, other: { type: 'remote' } } } });
  const rendered = renderOpenCodeConfig(source, 'kiokuko-ai', undefined, { runtime });
  const parsed = parse(rendered.content) as { mcp: { kiokuko?: unknown; servers: { kiokuko: unknown; other: unknown } } };
  assert.equal(parsed.mcp.kiokuko, undefined);
  assert.deepEqual(parsed.mcp.servers.kiokuko, current);
  assert.deepEqual(parsed.mcp.servers.other, { type: 'remote' });
  assert.equal(renderOpenCodeConfig(rendered.content, 'kiokuko-ai', undefined, { runtime }).action, 'unchanged');
  for (const conflicting of [
    { ...legacy, environment: { KIOKUKO_SKILL_DISCOVERY: 'official' } },
    { ...legacy, command: ['kiokuko', 'mcp'] },
  ]) {
    assert.throws(() => renderOpenCodeConfig(JSON.stringify({ mcp: { kiokuko: conflicting, servers: { kiokuko: current } } }),
      'kiokuko-ai', undefined, { runtime }), (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT');
  }
});

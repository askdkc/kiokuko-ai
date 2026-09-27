import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { renderOpenCodeConfig } from '../../src/setup/opencode-config.js';
import { agentDefinition, buildExecutionCatalog, MANAGED_EXECUTION_AGENTS, orchestrationOptionsSchema } from '../../src/execution/catalog.js';
import { fixtureCatalogInput } from '../fixtures/execution-selection.js';

test('templates preserve comments, explicit depth, custom definitions and user-edited managed agents', () => {
  const custom = agentDefinition('gokiWorker', 'private/custom-model');
  const source = '{\n// retain\n"model":"parent/model","experimental":{"subagent_depth":1},"agents":{"my-worker":' + JSON.stringify(custom) + '},"plugins":[{"package":"kiokuko-ai","options":{"orchestration":{"mode":"off","customAgents":{"gokiWorker":["my-worker"]}}}}]}';
  const result = renderOpenCodeConfig(source, 'kiokuko-ai', undefined, { executionTemplates: true });
  const root = parse(result.content);
  assert.match(result.content, /\/\/ retain/u);
  assert.equal(root.model, 'parent/model');
  assert.equal(root.experimental.subagent_depth, 1);
  assert.deepEqual(root.agents['my-worker'], custom);
  assert.equal(root.plugins[0].options.orchestration.mode, 'off');
  assert.equal(renderOpenCodeConfig(result.content, 'kiokuko-ai', undefined, { executionTemplates: true }).action, 'unchanged');
  const managed = Object.keys(MANAGED_EXECUTION_AGENTS)[0]!;
  root.agents[managed].model = 'private/changed-model';
  const updated = parse(renderOpenCodeConfig(JSON.stringify(root), 'kiokuko-ai', undefined, { executionTemplates: true, ennoOduno: 'ask' }).content);
  assert.equal(updated.agents[managed].model, 'private/changed-model');
  assert.equal(updated.plugins[0].options.orchestration.mode, 'ask');
});

test('custom candidates require registration, a connected tool-capable model and the role permission envelope', () => {
  const custom = agentDefinition('gokiWorker', 'private/custom-model');
  const agents = { 'my-worker': custom, unrelated: custom };
  const options = orchestrationOptionsSchema.parse({ customAgents: { gokiWorker: ['my-worker'] } });
  const catalog = buildExecutionCatalog(fixtureCatalogInput(agents), options);
  assert.equal(catalog.candidates.find(c => c.agent === 'my-worker')?.unavailable, null);
  assert.equal(catalog.candidates.some(c => c.agent === 'unrelated'), false);
  assert.equal(buildExecutionCatalog({ ...fixtureCatalogInput(agents), providers: [] }, options).candidates.find(c => c.agent === 'my-worker')?.unavailable, 'provider_disconnected');
  agents['my-worker'] = { ...custom, permissions: [] };
  assert.equal(buildExecutionCatalog(fixtureCatalogInput(agents), options).candidates.find(c => c.agent === 'my-worker')?.unavailable, 'permissions_invalid');
});

test('all localized README examples define a valid explicitly registered custom worker', async () => {
  const { readFile } = await import('node:fs/promises');
  let canonical: unknown;
  for (const file of ['README.md', 'README.ja.md', 'README.zh-CN.md', 'README.ko.md']) {
    const text = await readFile(file, 'utf8');
    const read = (marker: string) => parse(text.split(`<!-- ${marker} -->`)[1]!.split('```jsonc')[1]!.split('```')[0]!);
    const config = read('kiokuko-custom-worker-example');
    const options = orchestrationOptionsSchema.parse(read('kiokuko-custom-registration-example').orchestration);
    config.agents['my-orchestration-worker'].model = 'fixture/documented-worker';
    const candidate = buildExecutionCatalog(fixtureCatalogInput(config.agents), options).candidates.find(c => c.agent === 'my-orchestration-worker');
    assert.equal(candidate?.unavailable, null, file);
    if (canonical) assert.deepEqual(config, canonical); else canonical = config;
    const source = JSON.stringify({ ...config, plugins: [{ package: 'kiokuko-ai', options: { orchestration: options } }] });
    const updated = parse(renderOpenCodeConfig(source, 'kiokuko-ai', undefined, { executionTemplates: true }).content);
    assert.deepEqual(updated.agents['my-orchestration-worker'], config.agents['my-orchestration-worker']);
    assert.deepEqual(updated.plugins[0].options.orchestration.customAgents, options.customAgents);
  }
});

test('setup keeps comments inside existing plugin options and custom role registrations', () => {
  const source = `{
    "plugin": [["kiokuko-ai", {
      // keep my plugin note
      "orchestration": {
        "mode": "off", // keep my mode note
        "customAgents": { // keep my registrations note
          "gokiWorker": ["my-worker"]
        }
      }
    }]]
  }`;
  const rendered = renderOpenCodeConfig(source, 'kiokuko-ai', undefined, { executionTemplates: true, ennoOduno: 'ask' });
  for (const note of ['plugin', 'mode', 'registrations']) assert.ok(rendered.content.includes(`keep my ${note} note`));
  assert.equal(parse(rendered.content).plugins[0].options.orchestration.mode, 'ask');
});
